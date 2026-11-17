// A `pg` whose Client talks to the PGlite the test put on globalThis.deskTestDb.
export class Client {
  on() { return this; }
  async connect() {}
  query(text, params) { return globalThis.deskTestDb.query(text, params); }
  async end() {}
}
export default { Client };
