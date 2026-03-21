const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, fileName, fileType } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No document text provided.' });
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
      return res.status(502).json({ error: `API error: ${response.status}` });
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        json = JSON.parse(match[1]);
      } else {
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
}
