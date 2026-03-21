const crypto = require('crypto');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// In-memory cache (persists across warm invocations on Vercel)
const feedbackCache = new Map();

function hashDocContent(text) {
  return crypto.createHash('sha256').update(text.trim()).digest('hex');
}

const feedbackSystemPrompt = `You are tasked with reviewing a document. First, identify the subject area of the document (e.g., legal contract, financial report, technical specification, academic paper, business proposal, medical document, etc.). Then adopt the role of a senior expert in that specific domain.

Provide a thorough, professional review of the document with:

1. **Document Type & Your Expert Role**: Briefly state what type of document this is and what expert perspective you are adopting (e.g., "As a senior corporate attorney reviewing this shareholder agreement..." or "As a senior data engineer reviewing this technical specification...").

2. **Strengths**: What the document does well (2-4 points).

3. **Areas for Improvement**: Specific, actionable feedback on weaknesses, gaps, ambiguities, or risks (3-6 points). Be concrete — reference specific sections or content where possible.

4. **Critical Issues** (if any): Flag anything that could cause serious problems — legal risks, factual errors, missing essential elements, compliance concerns, etc.

5. **Overall Assessment**: A brief summary rating (Strong / Adequate / Needs Work) with a one-line justification.

Format your response in clean HTML using <h3>, <p>, <ul>, <li>, <strong>, and <span style="..."> tags for structure and emphasis. Use color accents: green (#2d7a4f) for strengths, orange (#c47a15) for improvements, red (#c0392b) for critical issues. Do NOT use markdown. Return ONLY the HTML content, no wrapping tags like <html> or <body>.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, fileName, fileType, dashboardTitle } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No document text provided.' });
  }

  const maxChars = 100000;
  let docText = text;
  if (docText.length > maxChars) {
    docText = docText.substring(0, maxChars);
  }

  // Check cache by content hash
  const contentHash = hashDocContent(docText);
  if (feedbackCache.has(contentHash)) {
    console.log('Feedback cache hit for hash:', contentHash.substring(0, 12));
    return res.json({ feedback: feedbackCache.get(contentHash) });
  }

  const userMessage = `File: "${fileName}" (${fileType})
Document Title: "${dashboardTitle}"

--- DOCUMENT CONTENT ---
${docText}
--- END ---

Please review this document as a domain expert.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: feedbackSystemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', response.status, err);
      return res.status(502).json({ error: `API error: ${response.status}` });
    }

    const data = await response.json();
    const feedback = data.content?.[0]?.text || '';

    // Cache the result
    feedbackCache.set(contentHash, feedback);
    console.log('Feedback cached for hash:', contentHash.substring(0, 12));

    res.json({ feedback });
  } catch (err) {
    console.error('Feedback error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
