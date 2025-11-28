export default async function handler(req, res) {
  res.status(200).json({
    status: "ok",
    message: "Forensic service is working"
  });
}

