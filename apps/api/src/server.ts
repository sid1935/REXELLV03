import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 8080);
const { server } = buildApp({
  location: process.env['REXELL_DB'] ?? 'rexell.sqlite',
  logger: true,
});

server.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  server.log.error(err);
  process.exit(1);
});
