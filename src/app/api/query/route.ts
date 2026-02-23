import { NextRequest, NextResponse } from "next/server";
import { toSearchQuery } from "@/lib/embeddings";
import { generateAnswer, type AnswerMode } from "@/lib/llm";
import { hashQuestion, getCachedAnswer, cacheAnswer } from "@/lib/cache";
import { getServiceSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 30; // 30 seconds max for Vercel Hobby

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await request.json();
    const { question, course, mode = "simple" } = body;

    // Validate input
    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return NextResponse.json(
        { error: "Question is required" },
        { status: 400 }
      );
    }

    if (!course || typeof course !== "string") {
      return NextResponse.json(
        { error: "Course selection is required" },
        { status: 400 }
      );
    }

    const validModes: AnswerMode[] = ["simple", "exam", "summary"];
    if (!validModes.includes(mode as AnswerMode)) {
      return NextResponse.json(
        { error: "Invalid mode. Use: simple, exam, or summary" },
        { status: 400 }
      );
    }

    // Step 1: Check cache
    const qHash = hashQuestion(question, course, mode);
    const cached = await getCachedAnswer(qHash);

    if (cached) {
      // Log analytics
      await logAnalytics(course, question, mode, true, Date.now() - startTime);

      return NextResponse.json({
        answer: cached.answer,
        sources: cached.sources,
        cached: true,
        responseTime: Date.now() - startTime,
      });
    }

    // Step 2: Full-text search for matching chunks
    const supabase = getServiceSupabase();
    const searchQuery = toSearchQuery(question);

    let matches: any[] = [];

    if (searchQuery) {
      // Try full-text search first
      const { data: ftsMatches, error: ftsError } = await supabase
        .from("chunks")
        .select(`
          id,
          content,
          chunk_index,
          document_id,
          documents!inner(course_name, status)
        `)
        .eq("documents.course_name", course)
        .eq("documents.status", "completed")
        .textSearch("content", searchQuery)
        .limit(5);

      if (!ftsError && ftsMatches && ftsMatches.length > 0) {
        matches = ftsMatches;
      } else {
        // Fallback: use ILIKE with keywords for broader matching
        const keywords = question
          .replace(/[^\w\s]/g, "")
          .split(/\s+/)
          .filter((w) => w.length > 2);

        if (keywords.length > 0) {
          // Search for chunks containing any of the keywords
          const orFilter = keywords
            .map((kw) => `content.ilike.%${kw}%`)
            .join(",");

          const { data: likeMatches, error: likeError } = await supabase
            .from("chunks")
            .select(`
              id,
              content,
              chunk_index,
              document_id,
              documents!inner(course_name, status)
            `)
            .eq("documents.course_name", course)
            .eq("documents.status", "completed")
            .or(orFilter)
            .limit(5);

          if (!likeError && likeMatches) {
            matches = likeMatches;
          }
        }
      }
    }

    if (!matches || matches.length === 0) {
      return NextResponse.json({
        answer:
          "No relevant content found in the syllabus for this course. Please make sure the syllabus has been uploaded.",
        sources: [],
        cached: false,
        responseTime: Date.now() - startTime,
      });
    }

    // Step 3: Extract context chunks
    const contextChunks = matches.map((m: any) => m.content);
    const sources = matches.map(
      (m: any) =>
        `[Chunk ${m.chunk_index + 1}] ${m.content.substring(0, 100)}...`
    );

    // Step 4: Generate answer via LLM
    const answer = await generateAnswer(
      question,
      contextChunks,
      mode as AnswerMode
    );

    // Step 5: Cache the result
    await cacheAnswer(qHash, question, course, mode, answer, sources);

    // Step 6: Log analytics
    await logAnalytics(course, question, mode, false, Date.now() - startTime);

    return NextResponse.json({
      answer,
      sources,
      cached: false,
      responseTime: Date.now() - startTime,
    });
  } catch (error: any) {
    console.error("Query API error:", error);
    return NextResponse.json(
      { error: "Internal server error. Please try again." },
      { status: 500 }
    );
  }
}

async function logAnalytics(
  course: string,
  question: string,
  mode: string,
  cached: boolean,
  responseTimeMs: number
) {
  try {
    const supabase = getServiceSupabase();
    await supabase.from("analytics").insert({
      course_name: course,
      question,
      mode,
      cached,
      response_time_ms: responseTimeMs,
    });
  } catch (err) {
    // Non-critical - don't fail the request
    console.error("Analytics logging failed:", err);
  }
}
