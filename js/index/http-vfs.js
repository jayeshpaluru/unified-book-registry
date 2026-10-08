import { FacadeVFS } from '../../vendor/wa-sqlite/src/FacadeVFS.js';
import * as SQLite from '../../vendor/wa-sqlite/src/sqlite-constants.js';

export class HttpReadonlyVFS extends FacadeVFS {
  constructor(module, reader) { super('anna-http-readonly', module); this.reader = reader; this.files = new Set(); }
  async jOpen(name, fileId, flags, outFlags) {
    if (name !== '/anna.sqlite' || !(flags & SQLite.SQLITE_OPEN_MAIN_DB) || flags & (SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE)) return SQLite.SQLITE_CANTOPEN;
    this.files.add(fileId); outFlags.setInt32(0, SQLite.SQLITE_OPEN_READONLY, true); return SQLite.SQLITE_OK;
  }
  jClose(fileId) { this.files.delete(fileId); return SQLite.SQLITE_OK; }
  async jRead(fileId, output, offset) {
    output.fill(0);
    if (!this.files.has(fileId)) return SQLite.SQLITE_IOERR_READ;
    try {
      const bytes = await this.reader.read(offset, output.byteLength); output.set(bytes);
      return bytes.length === output.byteLength ? SQLite.SQLITE_OK : SQLite.SQLITE_IOERR_SHORT_READ;
    } catch (error) { this.reader.error = error.message; return SQLite.SQLITE_IOERR_READ; }
  }
  jFileSize(fileId, size) { size.setBigInt64(0, BigInt(this.reader.size), true); return SQLite.SQLITE_OK; }
  jAccess(name, flags, result) { result.setInt32(0, name === '/anna.sqlite' && flags !== SQLite.SQLITE_ACCESS_READWRITE ? 1 : 0, true); return SQLite.SQLITE_OK; }
  jWrite() { return SQLite.SQLITE_READONLY; }
  jTruncate() { return SQLite.SQLITE_READONLY; }
  jDelete() { return SQLite.SQLITE_READONLY; }
  jDeviceCharacteristics() { return SQLite.SQLITE_IOCAP_IMMUTABLE; }
}
