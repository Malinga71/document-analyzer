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

const SYSTEM_PROMPT = `You are an expert document analyst. Your task is to convert a document into a structured JSON representation that captures ALL content with perfect fidelity. This will be rendered as interactive analysis cards.

CRITICAL RULES FOR CONTENT FIDELITY:
1. EVERY piece of content in the document MUST appear in your output — do not summarize, paraphrase, or skip anything. If the document has 30 clauses, all 30 must appear.
2. USE THE DOCUMENT'S OWN TITLES AND HEADINGS as module titles. Do NOT invent or rephrase section titles. If the document says "SCHEDULE 1 – REPAYMENT TERMS", use that exact text.
3. Preserve the document's hierarchy: main sections become modules, sub-sections become items within those modules.
4. TABLES must be rendered as "comparison" type with the EXACT column headers from the document, not generic ones.
5. NUMBERED LISTS and LETTERED LISTS (a, b, c or i, ii, iii) must preserve their numbering/lettering in the output.
6. Maintain the document's original ORDER — modules should follow the same sequence as sections in the document.

APPROACH — follow these steps mentally before generating JSON:
Step 1: Identify the document's structure — title, sections, sub-sections, tables, lists, definitions, schedules/annexures.
Step 2: Map each section to the best module type (see below).
Step 3: Verify completeness — cross-check that no section, clause, table, or paragraph is missing.

Return a JSON object:
{
  "title": "The document's actual title (from the document, not invented)",
  "subtitle": "Document type + key identifier (e.g., 'Loan Agreement between X and Y, dated...')",
  "modules": [
    {
      "id": "mod_1",
      "title": "Exact section title from the document",
      "tag": "category_key",
      "clauseRef": "Cl. 3.1 or S. 2 (if the document uses section/clause numbers)",
      "fullWidth": false,
      "type": "items | comparison | milestones | steps | definitions | vetoList | clauseList",
      ... type-specific fields
    }
  ],
  "tags": {
    "category_key": { "label": "Display Name", "bg": "#hex_background", "color": "#hex_text" }
  }
}

MODULE TYPES — choose the BEST match for each section's content:

1. "items" (DEFAULT — use for narrative sections, clauses with sub-points, mixed content):
   "items": [{ "label": "SUB-HEADING OR LABEL", "content": "Full text content. Use <strong> for bold, <br> for line breaks, <em> for emphasis. Preserve all details." }]
   IMPORTANT: Each item's "label" should be the actual sub-heading, clause reference, or descriptive label FROM the document. The "content" should contain the COMPLETE text — do not truncate.

2. "comparison" (for ANY tabular data — schedules, fee tables, comparison matrices, data grids):
   "columns": ["Exact Column Header 1", "Exact Column Header 2", ...],
   "rows": [["Cell value", "Cell value", ...]]
   IMPORTANT: Use the table's ACTUAL column headers. Include ALL rows, not a sample. Set "fullWidth": true.

3. "milestones" (percentage-based items — vesting schedules, equity splits, completion stages):
   "milestones": [{ "pct": "25%", "label": "Description" }]

4. "steps" (sequential processes, numbered procedures, timelines, roadmaps):
   "steps": [{ "num": 1, "color": "teal|orange", "title": "Step Title", "desc": "Full description" }]

5. "definitions" (term-definition pairs, glossary, interpretation sections):
   "definitions": [{ "term": "Exact Term", "meaning": "Exact definition from the document" }]
   IMPORTANT: Include EVERY definition from the document.

6. "vetoList" (restrictions, prohibitions, negative covenants, reserved matters, risk items):
   "vetoItems": ["Full text of each restriction"]

7. "clauseList" (flat lists — deliverables, scope items, features, obligations, conditions):
   "listColor": "teal|orange",
   "clauseItems": ["<strong>Label/Number:</strong> full text of each item"]

ALERTS: Add to any module if needed: "alerts": [{"type": "warn|info", "text": "Alert text"}]
- Use "warn" for blank fields, missing information, unusual terms, or potential issues.
- Use "info" for cross-references, notes, or context.

TAG RULES:
- Auto-detect 3-7 logical categories from the document content (e.g., "Legal", "Financial", "Operations", "Governance", "Technical", "HR", "Compliance", "Schedules").
- Use these bg colors: #e8ecf1, #d0e4dd, #fef3dc, #ebe0f5, #fde2e2, #d1ecf1, #dff0d8, #f5e6ca, #e0e7ff.
- Use appropriate dark text colors for readability.
- Set "fullWidth": true for overview/summary modules, comparison tables, and any wide content.

GROUPING RULES:
- Each major section/heading in the document should be its own module.
- Sub-sections within a major section should be items within that module, NOT separate modules (unless they are substantial enough to warrant their own module).
- Schedules, annexures, and appendices should each be their own module.
- If a section contains a mix of narrative text and a table, create TWO modules: one "items" for the narrative, one "comparison" for the table.
- If the document has HTML structure hints (headings, tables), use those to determine hierarchy.

BLANK FIELDS: For blank fields, placeholders, or lines in the document, use: <span class="blank">______</span>

OUTPUT: Return ONLY valid JSON. No markdown fences, no commentary, no trailing commas.`;

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
        max_tokens: 32000,
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

const feedbackSystemPrompt = `You are tasked with reviewing a document. First, identify the subject area of the document (e.g., legal contract, financial report, technical specification, academic paper, business proposal, medical document, etc.). Then adopt the role of a senior expert in that specific domain.

Provide a thorough, professional review of the document with:

1. **Document Type & Your Expert Role**: Briefly state what type of document this is and what expert perspective you are adopting (e.g., "As a senior corporate attorney reviewing this shareholder agreement..." or "As a senior data engineer reviewing this technical specification...").

2. **Strengths**: What the document does well (2-4 points).

3. **Areas for Improvement**: Specific, actionable feedback on weaknesses, gaps, ambiguities, or risks (3-6 points). Be concrete — reference specific sections or content where possible.

4. **Critical Issues** (if any): Flag anything that could cause serious problems — legal risks, factual errors, missing essential elements, compliance concerns, etc.

5. **Overall Assessment**: A brief summary rating (Strong / Adequate / Needs Work) with a one-line justification.

Format your response in clean HTML using <h3>, <p>, <ul>, <li>, <strong>, and <span style="..."> tags for structure and emphasis. Use color accents: green (#2d7a4f) for strengths, orange (#c47a15) for improvements, red (#c0392b) for critical issues. Do NOT use markdown. Return ONLY the HTML content, no wrapping tags like <html> or <body>.`;

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

    feedbackCache.set(contentHash, feedback);
    console.log('Feedback cached for hash:', contentHash.substring(0, 12));

    res.json({ feedback });
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
