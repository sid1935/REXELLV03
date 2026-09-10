import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 8080);
const app = buildApp({
  location: process.env['REXELL_DB'] ?? 'rexell.sqlite',
  logger: true,
});

const { server } = app;

if (app.db.migration.applied.length > 0) {
  server.log.info(
    { from: app.db.migration.from, to: app.db.migration.to, applied: app.db.migration.applied },
    'schema migrated on startup',
  );
}

server.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  server.log.error(err);
  process.exit(1);
});
