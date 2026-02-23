export type AnswerMode = "simple" | "exam" | "summary";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

const SYSTEM_PROMPTS: Record<AnswerMode, string> = {
  simple: `You are an academic assistant for ABES Engineering College.
Answer the student's question using ONLY the provided context from their syllabus.
Explain concepts clearly as if teaching a first-year student. Use simple language and examples.
If the answer is not found in the context, respond with: "This topic was not found in your syllabus."
Do NOT make up information. Always base your answer on the provided context.`,

  exam: `You are an academic assistant for ABES Engineering College.
Answer the student's question using ONLY the provided context from their syllabus.
Format your answer in a structured, exam-ready format:
- Use clear headings and subheadings
- Include definitions, key points, and important formulas
- Write in a formal academic tone suitable for exam answers
- Organize content logically with numbered points
If the answer is not found in the context, respond with: "This topic was not found in your syllabus."
Do NOT make up information.`,

  summary: `You are an academic assistant for ABES Engineering College.
Answer the student's question using ONLY the provided context from their syllabus.
Provide a concise summary with:
- Maximum 5 key bullet points
- Each point should be one clear sentence
- Highlight the most important concepts
- Include any critical formulas or definitions
If the answer is not found in the context, respond with: "This topic was not found in your syllabus."
Do NOT make up information.`,
};

/**
 * Call the Groq LLM API to generate an answer.
 */
export async function generateAnswer(
  question: string,
  contextChunks: string[],
  mode: AnswerMode = "simple"
): Promise<string> {
  const context = contextChunks.join("\n\n---\n\n");

  const systemContent = SYSTEM_PROMPTS[mode];
  const userContent = `--- SYLLABUS CONTEXT ---\n${context}\n--- END CONTEXT ---\n\nStudent's Question: ${question}`;

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    throw new Error("Missing GROQ_API_KEY environment variable");
  }

  try {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userContent },
        ],
        max_tokens: 800,
        temperature: 0.3,
        top_p: 0.9,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Groq API Error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = await response.json();
    return data.choices[0].message.content || "No answer generated.";
  } catch (error: any) {
    console.error("Groq LLM failed:", error.message);

    // Fallback to a different Groq model
    try {
      console.log("Attempting fallback to gemma2-9b-it...");
      const fallbackResponse = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gemma2-9b-it",
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: userContent },
          ],
          max_tokens: 500,
          temperature: 0.3,
        }),
      });

      if (!fallbackResponse.ok) {
        throw new Error(`Fallback failed: ${fallbackResponse.status}`);
      }

      const fallbackData = await fallbackResponse.json();
      return fallbackData.choices[0].message.content || "No answer generated.";
    } catch (fallbackError: any) {
      console.error("Fallback LLM also failed:", fallbackError.message);
      return "I'm sorry, the AI service is temporarily unavailable. Please try again in a moment.";
    }
  }
}
