const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

// Attempt to repair truncated JSON by closing open brackets/braces
function repairTruncatedJSON(str) {
  // Remove any trailing incomplete string or value
  let s = str.replace(/,\s*$/, '');
  // Remove incomplete last key-value pair
  s = s.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, '');
  // Count open brackets and braces
  let braces = 0, brackets = 0, inString = false, escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }
  // Close any open strings
  if (inString) s += '"';
  // Close open brackets and braces
  while (brackets > 0) { s += ']'; brackets--; }
  while (braces > 0) { s += '}'; braces--; }
  return JSON.parse(s);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const { text, fileName, fileType } = body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: `No document text provided. Body keys: ${Object.keys(body).join(', ') || 'none'}. Body type: ${typeof req.body}` });
  }

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
      let detail = '';
      try { detail = JSON.parse(err)?.error?.message || err; } catch { detail = err.substring(0, 200); }
      return res.status(502).json({ error: `API error ${response.status}: ${detail}` });
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try { json = JSON.parse(match[1]); } catch { json = repairTruncatedJSON(match[1]); }
      } else {
        const start = raw.indexOf('{');
        if (start !== -1) {
          const jsonStr = raw.substring(start);
          try {
            json = JSON.parse(jsonStr);
          } catch {
            json = repairTruncatedJSON(jsonStr);
          }
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
}
