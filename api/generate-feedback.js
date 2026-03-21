const crypto = require('crypto');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// In-memory cache (persists across warm invocations on Vercel)
const feedbackCache = new Map();

function hashDocContent(text) {
  return crypto.createHash('sha256').update(text.trim()).digest('hex');
}

async function callFeedbackAPI(systemPrompt, userMessage) {
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
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

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

  const docContext = `File: "${fileName}" (${fileType})\nDocument Title: "${dashboardTitle}"\n\n--- DOCUMENT CONTENT ---\n${docText}\n--- END ---`;

  const perspectives = [
    {
      system: `You are a senior domain expert reviewing a document. First, identify the subject area (legal, financial, technical, academic, business, medical, etc.) and adopt the role of the most relevant senior expert.

Focus your review on SUBSTANCE AND CONTENT quality:
- Is the content accurate, complete, and well-structured?
- Are there factual errors, logical gaps, or missing critical elements?
- Are terms, definitions, and obligations clearly stated?
- Does the document achieve its apparent purpose effectively?

Format your response in clean HTML using <h3>, <p>, <ul>, <li>, <strong>, and <span style="..."> tags. Use color accents: green (#2d7a4f) for strengths, orange (#c47a15) for improvements, red (#c0392b) for critical issues. Return ONLY HTML content.`
    },
    {
      system: `You are a senior risk and compliance analyst reviewing a document. First, identify the document type and adopt the perspective of a risk/compliance expert in that specific domain.

Focus your review on RISKS AND COMPLIANCE:
- Legal exposure, regulatory compliance gaps, or liability concerns
- Ambiguous language that could be exploited or misinterpreted
- Missing protections, safeguards, or standard clauses expected in this type of document
- Enforceability issues, jurisdiction concerns, or procedural gaps

Format your response in clean HTML using <h3>, <p>, <ul>, <li>, <strong>, and <span style="..."> tags. Use color accents: green (#2d7a4f) for strengths, orange (#c47a15) for improvements, red (#c0392b) for critical issues. Return ONLY HTML content.`
    },
    {
      system: `You are a senior professional editor and strategic advisor reviewing a document. First, identify the document type and adopt the perspective of an editorial and strategic expert in that domain.

Focus your review on CLARITY, STRATEGY, AND BEST PRACTICES:
- Writing quality: clarity, conciseness, professional tone, consistency
- Strategic positioning: does the document serve the interests of the parties appropriately?
- Industry best practices: how does this compare to best-in-class documents of this type?
- Practical recommendations: specific, actionable improvements with examples where possible

Format your response in clean HTML using <h3>, <p>, <ul>, <li>, <strong>, and <span style="..."> tags. Use color accents: green (#2d7a4f) for strengths, orange (#c47a15) for improvements, red (#c0392b) for critical issues. Return ONLY HTML content.`
    }
  ];

  try {
    console.log('Running 3 parallel feedback analyses for hash:', contentHash.substring(0, 12));

    const reviewPromises = perspectives.map(p =>
      callFeedbackAPI(p.system, `${docContext}\n\nPlease review this document from your expert perspective.`)
    );
    const reviews = await Promise.all(reviewPromises);

    console.log('Synthesizing 3 reviews into final feedback...');

    const synthesisPrompt = `You are a senior editorial synthesizer. You have received THREE independent expert reviews of the same document. Your job is to produce ONE final, authoritative, high-quality review that:

1. Combines the best insights from all three reviews — do not lose any important point
2. Eliminates redundancy — merge overlapping observations into single, stronger points
3. Prioritizes by impact — lead with the most critical findings
4. Maintains a clear structure with these sections:
   - **Document Type & Expert Panel**: Briefly state the document type and note that this review synthesizes multiple expert perspectives
   - **Key Strengths** (3-5 consolidated points)
   - **Areas for Improvement** (4-8 consolidated, actionable points — be specific, reference sections)
   - **Critical Issues** (if any — only truly serious concerns that appeared across reviews or are high-severity)
   - **Overall Assessment**: A rating (Strong / Adequate / Needs Work) with a 2-3 line justification

Format in clean HTML using <h3>, <p>, <ul>, <li>, <strong>, and <span style="..."> tags.
Use color accents: green (#2d7a4f) for strengths, orange (#c47a15) for improvements, red (#c0392b) for critical issues.
Do NOT use markdown. Return ONLY the HTML content, no wrapping tags.`;

    const synthesisInput = `--- REVIEW 1 (Content & Substance Expert) ---
${reviews[0]}

--- REVIEW 2 (Risk & Compliance Expert) ---
${reviews[1]}

--- REVIEW 3 (Clarity & Strategy Expert) ---
${reviews[2]}

Synthesize these three reviews into one final, comprehensive, high-quality review.`;

    const finalFeedback = await callFeedbackAPI(synthesisPrompt, synthesisInput);

    feedbackCache.set(contentHash, finalFeedback);
    console.log('Feedback cached for hash:', contentHash.substring(0, 12));

    res.json({ feedback: finalFeedback });
  } catch (err) {
    console.error('Feedback error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
