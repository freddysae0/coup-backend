import {createCoupServer} from './server';

const num = (value: string | undefined, fallback: number) =>
  value !== undefined && value !== '' ? Number(value) : fallback;

const coup = createCoupServer({
  responseTimeoutMs: num(process.env.RESPONSE_TIMEOUT_MS, 30_000),
  disconnectGraceMs: num(process.env.DISCONNECT_GRACE_MS, 120_000),
  log: (...args) => console.log(new Date().toISOString(), ...args),
});

const port = num(process.env.PORT, 8000);
void coup.listen(port).then(p => {
  console.log(
    `Coup server listening on http://localhost:${p} (WebSocket on the same port)`,
  );
});

const shutdown = () => {
  void coup.close().then(() => {
    process.exitCode = 0;
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
