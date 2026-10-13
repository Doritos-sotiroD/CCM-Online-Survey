// ZIP "store" entries: no compression library, network request, or data changes.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createResultsZip(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > 65535) {
    throw new Error("RESULTS_ZIP_FILES_INVALID");
  }
  const encoder = new TextEncoder();
  const names = new Set();
  const entries = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const file of files) {
    if (typeof file?.filename !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(file.filename) ||
        names.has(file.filename) || typeof file.data !== "string") {
      throw new Error("RESULTS_ZIP_ENTRY_INVALID");
    }
    names.add(file.filename);
    const name = encoder.encode(file.filename);
    const bytes = encoder.encode(file.data);
    const checksum = crc32(bytes);
    if (name.length > 65535 || bytes.length > 0xffffffff ||
        offset + 30 + name.length + bytes.length > 0xffffffff) {
      throw new Error("RESULTS_ZIP_TOO_LARGE");
    }

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // ZIP version 2.0.
    local.setUint16(6, 0x0800, true); // UTF-8 names and contents.
    local.setUint16(12, 0x0021, true); // Fixed ZIP date: January 1, 1980.
    local.setUint32(14, checksum, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    entries.push(local.buffer, name, bytes);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(14, 0x0021, true);
    central.setUint32(16, checksum, true);
    central.setUint32(20, bytes.length, true);
    central.setUint32(24, bytes.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    directory.push(central.buffer, name);
    directorySize += 46 + name.length;
    offset += 30 + name.length + bytes.length;
  }
  if (offset + directorySize + 22 > 0xffffffff) throw new Error("RESULTS_ZIP_TOO_LARGE");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...entries, ...directory, end.buffer], { type: "application/zip" });
}
