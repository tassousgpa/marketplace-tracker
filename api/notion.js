module.exports = async function handler(req, res) {
  const dbId = req.query.db;
  if (!dbId) {
    return res.status(400).json({ error: "Missing ?db= parameter" });
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "NOTION_TOKEN not configured" });
  }

  try {
    const notionRes = await fetch(
      `https://api.notion.com/v1/databases/${encodeURIComponent(dbId)}/query`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page_size: 100 }),
      }
    );

    if (!notionRes.ok) {
      const err = await notionRes.text();
      return res.status(notionRes.status).json({ error: err });
    }

    const data = await notionRes.json();
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
