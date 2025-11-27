module.exports = async (req, res) => {
  try {
    console.log("analyze invoked");

    if (req.method === "GET") {
      return res.status(200).json({ ok: true, note: "health ok" });
    }

    let data = req.body || {};

    return res.status(200).json({
      ok: true,
      received: data
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal" });
  }
};
