// Optional Vercel serverless endpoint for Nebula Search.
// Configure BRAVE_SEARCH_API_KEY in your deployment's environment variables.
// This endpoint keeps the API key on the server instead of exposing it in browser code.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const query = typeof req.query?.q === "string" ? req.query.q.trim() : "";
  if (!query) return res.status(400).json({ error: "Missing search query" });

  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "Search API is not configured",
      hint: "Set BRAVE_SEARCH_API_KEY in your deployment environment."
    });
  }

  try {
    const upstream = await fetch(
      "https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(query) + "&count=8",
      { headers: { "Accept": "application/json", "X-Subscription-Token": apiKey } }
    );

    if (!upstream.ok) {
      return res.status(502).json({ error: "Search provider returned an error" });
    }

    const data = await upstream.json();
    const results = (data.web?.results || []).slice(0, 8).map((item) => ({
      title: item.title || "Untitled result",
      url: item.url,
      description: item.description || ""
    })).filter((item) => typeof item.url === "string" && /^https?:\/\//i.test(item.url));

    return res.status(200).json({ results });
  } catch (error) {
    return res.status(502).json({ error: "Unable to reach search provider" });
  }
}
