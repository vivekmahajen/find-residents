'use strict';

// Vercel serverless entrypoint. Reuses the same request handler as the
// standalone server (server.js exports it and only calls listen() when run
// directly). vercel.json rewrites all routes here.
module.exports = require('../server.js');
