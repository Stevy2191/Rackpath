// Reads the X-Project-ID request header and exposes it as req.projectId.
// Every project-scoped query/insert uses this value. When the header is
// missing or invalid we fall back to the Default Project (id 1).
function projectScope(req, res, next) {
  const raw = req.headers['x-project-id'];
  const id = parseInt(raw, 10);
  req.projectId = Number.isInteger(id) && id > 0 ? id : 1;
  next();
}

module.exports = { projectScope };
