import { NextRequest, NextResponse } from "next/server";
import { extractTextFromPDF, chunkText } from "@/lib/pdf";
import { getServiceSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60; // Allow more time for PDF processing

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const course = formData.get("course") as string | null;

    // Validate input
    if (!file) {
      return NextResponse.json({ error: "PDF file is required" }, { status: 400 });
    }

    if (!course || course.trim().length === 0) {
      return NextResponse.json(
        { error: "Course name is required" },
        { status: 400 }
      );
    }

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json(
        { error: "Only PDF files are accepted" },
        { status: 400 }
      );
    }

    // Max 10MB
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File size must be under 10MB" },
        { status: 400 }
      );
    }

    const supabase = getServiceSupabase();

    // Step 1: Create document record
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .insert({
        course_name: course.trim(),
        file_name: file.name,
        status: "processing",
      })
      .select("id")
      .single();

    if (docError || !doc) {
      console.error("Document insert error:", docError);
      return NextResponse.json(
        { error: "Failed to create document record" },
        { status: 500 }
      );
    }

    const documentId = doc.id;

    // Step 2: Upload PDF to Supabase Storage
    const buffer = Buffer.from(await file.arrayBuffer());
    const storagePath = `${course.trim().replace(/\s+/g, "_")}/${documentId}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from("syllabus-pdfs")
      .upload(storagePath, buffer, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      // Continue anyway - storage is optional, processing can still work
    } else {
      // Update file_path
      await supabase
        .from("documents")
        .update({ file_path: storagePath })
        .eq("id", documentId);
    }

    // Step 3: Extract text from PDF
    let text: string;
    try {
      text = await extractTextFromPDF(buffer);
    } catch (parseError: any) {
      console.error("PDF parse error:", parseError);
      await supabase
        .from("documents")
        .update({ status: "error" })
        .eq("id", documentId);
      return NextResponse.json(
        { error: "Failed to parse PDF. Ensure it contains selectable text." },
        { status: 400 }
      );
    }

    if (text.trim().length < 100) {
      await supabase
        .from("documents")
        .update({ status: "error" })
        .eq("id", documentId);
      return NextResponse.json(
        { error: "PDF contains insufficient text content." },
        { status: 400 }
      );
    }

    // Step 4: Chunk the text
    const chunks = chunkText(text, 200, 50);

    // Step 5: Insert chunks (no embeddings - using full-text search instead)
    const chunkRecords = chunks.map((content, index) => ({
      document_id: documentId,
      content,
      chunk_index: index,
      metadata: { char_count: content.length },
    }));

    // Insert in batches of 20
    const batchSize = 20;
    for (let i = 0; i < chunkRecords.length; i += batchSize) {
      const batch = chunkRecords.slice(i, i + batchSize);
      const { error: insertError } = await supabase
        .from("chunks")
        .insert(batch);

      if (insertError) {
        console.error("Chunk insert error:", insertError);
        await supabase
          .from("documents")
          .update({ status: "error" })
          .eq("id", documentId);
        return NextResponse.json(
          { error: `Failed to store document chunks: ${insertError.message}` },
          { status: 500 }
        );
      }
    }

    // Step 6: Update document status
    await supabase
      .from("documents")
      .update({
        status: "completed",
        chunks_count: chunks.length,
      })
      .eq("id", documentId);

    return NextResponse.json({
      status: "success",
      documentId,
      chunksCreated: chunks.length,
      message: `Successfully processed ${file.name} into ${chunks.length} searchable chunks.`,
    });
  } catch (error: any) {
    console.error("Upload API error:", error?.message || error);
    console.error("Stack trace:", error?.stack);
    return NextResponse.json(
      { error: `Internal server error during upload: ${error?.message || "Unknown error"}` },
      { status: 500 }
    );
  }
}
