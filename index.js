const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Health check (Railway needs this)
app.get("/", (req, res) => {
  res.status(200).send("Jalendr calendar bridge is running ✅");
});

// Example future endpoint (leave for later)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
