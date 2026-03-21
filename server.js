const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('\n  ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  console.error('  Run:  ANTHROPIC_API_KEY=sk-ant-... npm start\n');
  process.exit(1);
}

const SYSTEM_PROMPT = `You are a document analyst that converts document content into modular, editable analysis cards. Analyze the provided document and structure ALL of its content into logical modules — do not omit any section.

Return a JSON object with this exact schema:

{
  "title": "Main document title",
  "subtitle": "Short generated description or date/purpose line",
  "modules": [
    {
      "id": "mod_1",
      "title": "Module Title",
      "tag": "category_key",
      "clauseRef": "",
      "fullWidth": false,
      "type": "items | comparison | milestones | steps | definitions | vetoList | clauseList",
      ... type-specific fields (see below)
    }
  ],
  "tags": {
    "category_key": { "label": "Display Name", "bg": "#hex_background", "color": "#hex_text" }
  }
}

MODULE TYPES — choose the best fit for each document section:

1. "items" (DEFAULT — use for most content):
   "items": [{ "label": "ITEM LABEL", "content": "Rich text. Use <strong> for bold, <br> for line breaks." }]

2. "comparison" (when document compares two or more things side-by-side):
   "columns": ["Col A Header", "Dimension", "Col B Header"],
   "rows": [["Value A", "Dimension Name", "Value B"]]

3. "milestones" (percentage-based stages, vesting tranches, progress gates):
   "milestones": [{ "pct": "20%", "label": "Description of this tranche" }]

4. "steps" (sequential process, roadmap, numbered timeline):
   "steps": [{ "num": 1, "color": "teal|orange", "title": "Step Title", "desc": "Description" }]

5. "definitions" (term-definition pairs, glossary, key concepts):
   "definitions": [{ "term": "Term Name", "meaning": "Definition text" }]

6. "vetoList" (restrictions, vetoes, prohibited items, reserved matters, risk items):
   "vetoItems": ["Restriction text 1", "Restriction text 2"]

7. "clauseList" (flat list of services, features, scope items, deliverables):
   "listColor": "teal|orange",
   "clauseItems": ["<strong>Label:</strong> description text"]

ALSO: if a module needs an alert/note, add: "alerts": [{"type": "warn|info", "text": "Alert text"}]

TAG RULES:
- Auto-detect 3-7 logical categories from the document (e.g., "Legal", "Financial", "Operations", "Strategy", "Technical", "HR", "Compliance").
- Use these bg colors distributed across tags: #e8ecf1, #d0e4dd, #fef3dc, #ebe0f5, #fde2e2, #d1ecf1, #dff0d8, #f5e6ca, #e0e7ff.
- Use appropriate dark text colors for readability.
- Set "fullWidth": true for overview/summary modules and comparison tables.
- If the document has clause/section numbers, include them in "clauseRef" (e.g., "Cl. 7" or "S. 3.2").

IMPORTANT:
- Cover ALL content from the document. Do not skip sections.
- For blank fields or placeholders in the document, use: <span class="blank">______</span>
- Be intelligent about grouping — related clauses can share a module.
- Return ONLY valid JSON. No markdown fences, no explanation, no trailing commas.`;

app.post('/api/generate-dashboard', async (req, res) => {
  const { text, fileName, fileType } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No document text provided.' });
  }

  // Truncate very large documents to ~100k chars
  const maxChars = 100000;
  let docText = text;
  let truncated = false;
  if (docText.length > maxChars) {
    docText = docText.substring(0, maxChars);
    truncated = true;
  }

  const userMessage = `File: "${fileName}" (${fileType})${truncated ? ' [TRUNCATED — very large document, first ~100k chars shown]' : ''}

--- DOCUMENT CONTENT ---
${docText}
--- END ---

Analyze the entire document above and return the analysis JSON.`;

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
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', response.status, err);
      return res.status(502).json({ error: `API error: ${response.status}` });
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';

    // Try to parse JSON — Claude sometimes wraps in ```json
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        json = JSON.parse(match[1]);
      } else {
        // Try to find JSON object boundaries
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
          json = JSON.parse(raw.substring(start, end + 1));
        } else {
          throw new Error('Could not parse AI response as JSON');
        }
      }
    }

    res.json(json);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Feedback cache (keyed by content hash) ──
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

// ── Feedback endpoint (3-pass + synthesis, cached by content) ──
app.post('/api/generate-feedback', async (req, res) => {
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

  // Three different expert perspectives for comprehensive coverage
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

    // Run all 3 feedback passes in parallel
    const reviewPromises = perspectives.map(p =>
      callFeedbackAPI(p.system, `${docContext}\n\nPlease review this document from your expert perspective.`)
    );
    const reviews = await Promise.all(reviewPromises);

    console.log('Synthesizing 3 reviews into final feedback...');

    // Synthesis pass: combine all 3 reviews into one authoritative feedback
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

    // Cache the result
    feedbackCache.set(contentHash, finalFeedback);
    console.log('Feedback cached for hash:', contentHash.substring(0, 12));

    res.json({ feedback: finalFeedback });
  } catch (err) {
    console.error('Feedback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Acorn Group Document Analyzer`);
  console.log(`  Running at http://localhost:${PORT}\n`);
});
