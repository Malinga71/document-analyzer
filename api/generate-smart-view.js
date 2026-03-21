const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SMART_VIEW_PROMPT = `You are an expert document analyst creating an insightful, analytical summary of a document. Instead of reproducing the document content verbatim, your job is to extract and present the most important insights, patterns, and implications in a way that maximizes understanding for the reader.

Create a JSON response with analytical cards that highlight what matters most:

{
  "cards": [
    {
      "title": "Card title",
      "icon": "emoji icon",
      "tag": "Category label",
      "tagBg": "#hex background",
      "tagColor": "#hex text",
      "headerBg": "#hex light background",
      "fullWidth": false,
      "content": "HTML content"
    }
  ]
}

CARD TYPES TO INCLUDE (choose the most relevant for the document):

1. **Executive Summary** (ALWAYS include, fullWidth: true)
   - 3-5 sentence overview of the document's purpose, key parties, and core terms
   - Icon: 📋

2. **Key Numbers & Figures** (if the document contains financial/quantitative data)
   - Extract ALL important numbers, amounts, dates, percentages, deadlines
   - Present as a clean list with bold labels
   - Icon: 📊

3. **Key Obligations & Responsibilities** (for contracts, agreements, policies)
   - Who must do what? Summarize each party's main obligations
   - Icon: ⚖️

4. **Risk Flags & Red Zones** (ALWAYS include)
   - Unusual terms, one-sided clauses, missing protections, ambiguous language
   - Potential issues a reader should be aware of
   - Use <span style="color:#c0392b"> for high-risk items
   - Icon: 🚩

5. **Timeline & Key Dates** (if applicable)
   - Deadlines, milestones, effective dates, expiry, renewal dates
   - Present chronologically
   - Icon: 📅

6. **Definitions & Key Terms** (if the document defines important terms)
   - Only the most important definitions that affect interpretation
   - Icon: 📖

7. **Relationships & Structure** (for complex documents)
   - How parties relate to each other, organizational structure, hierarchies
   - Icon: 🔗

8. **Conditions & Triggers** (if applicable)
   - What conditions must be met? What triggers certain actions?
   - Events of default, termination triggers, conditions precedent
   - Icon: ⚡

9. **What's Missing** (ALWAYS include)
   - Standard elements you'd expect in this type of document that are absent
   - Blank fields, undefined terms, missing schedules
   - Icon: ❓

10. **Bottom Line** (ALWAYS include, fullWidth: true)
    - 2-3 sentences: What should the reader take away? What action should they consider?
    - Icon: 💡

CONTENT FORMATTING RULES:
- Use clean HTML: <ul>, <li>, <strong>, <em>, <br>, <span style="...">
- Use color accents sparingly: green (#2d7a4f) for positive, orange (#c47a15) for caution, red (#c0392b) for risk
- Be specific — reference actual content from the document, don't be generic
- Keep each card focused and scannable — use bullet points over paragraphs
- DO NOT reproduce the full document text — this is an analytical view, not a copy

TAG COLORS (distribute across cards):
- Use these bg colors: #e8ecf1, #d0e4dd, #fef3dc, #ebe0f5, #fde2e2, #d1ecf1, #dff0d8, #f5e6ca, #e0e7ff
- headerBg should be a lighter version of the tag color
- Use appropriate dark text colors for tags

OUTPUT: Return ONLY valid JSON. No markdown fences, no commentary.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, fileName, fileType } = req.body || {};

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

  const userMessage = `File: "${fileName}" (${fileType})${truncated ? ' [TRUNCATED]' : ''}

--- DOCUMENT CONTENT ---
${docText}
--- END ---

Analyze this document and create the Smart View insight cards.`;

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
        system: SMART_VIEW_PROMPT,
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
    console.error('Smart view error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
