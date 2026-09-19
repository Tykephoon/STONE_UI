/**
 * CSV import.
 *
 * This is the only way data enters the app, and it parses files written by
 * other people's tools, so the tests lean on the awkward cases: quoted fields,
 * embedded newlines, alias column names, spreadsheet timestamps, unit mix-ups,
 * and rows that should be rejected without taking the rest of the file down.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapColumns,
  parseCsv,
  parseReadingsCsv,
  parseTimestamp,
  templateCsv,
  toCsv,
} from '../src/data/csv';

const DEVICE = 'dev_test';

describe('parseCsv', () => {
  it('parses a plain file', () => {
    const rows = parseCsv('a,b,c\n1,2,3');
    assert.deepEqual(rows, [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields containing commas', () => {
    const rows = parseCsv('name,value\n"Smith, John",42');
    assert.deepEqual(rows[1], ['Smith, John', '42']);
  });

  it('handles doubled quotes inside a quoted field', () => {
    const rows = parseCsv('note\n"He said ""hello"""');
    assert.equal(rows[1]?.[0], 'He said "hello"');
  });

  it('handles newlines inside a quoted field', () => {
    const rows = parseCsv('note,x\n"line one\nline two",5');
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.[0], 'line one\nline two');
    assert.equal(rows[1]?.[1], '5');
  });

  it('handles CRLF line endings', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n3,4');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[2], ['3', '4']);
  });

  it('strips a byte-order mark from the first header', () => {
    const rows = parseCsv('﻿recorded_at,latitude\n2026-01-01T00:00:00Z,1');
    assert.equal(rows[0]?.[0], 'recorded_at');
  });

  it('ignores trailing blank lines', () => {
    const rows = parseCsv('a\n1\n\n');
    assert.equal(rows.length, 2);
  });
});

describe('column mapping', () => {
  it('recognises canonical names', () => {
    const mapping = mapColumns(['recorded_at', 'latitude', 'longitude']);
    assert.equal(mapping.missingRequired.length, 0);
    assert.equal(mapping.recognised.size, 3);
  });

  it('recognises common aliases and differing case or spacing', () => {
    const mapping = mapColumns(['Timestamp', 'Lat', 'LON', 'Temperature', 'Battery']);
    assert.equal(mapping.missingRequired.length, 0);
    assert.deepEqual([...mapping.recognised.values()].sort(), [
      'ambient_temp_c',
      'battery_voltage_v',
      'latitude',
      'longitude',
      'recorded_at',
    ]);
  });

  it('reports missing required columns rather than guessing', () => {
    const mapping = mapColumns(['recorded_at', 'temperature']);
    assert.deepEqual(mapping.missingRequired, ['latitude', 'longitude']);
  });

  it('keeps unrecognised columns as extras', () => {
    const mapping = mapColumns(['recorded_at', 'lat', 'lon', 'rssi_dbm', 'driver']);
    assert.deepEqual([...mapping.extras.values()], ['rssi_dbm', 'driver']);
  });
});

describe('parseTimestamp', () => {
  it('accepts ISO-8601 with a zone', () => {
    assert.equal(parseTimestamp('2026-09-19T10:04:00Z'), '2026-09-19T10:04:00.000Z');
  });

  it('accepts an offset and normalises to UTC', () => {
    assert.equal(parseTimestamp('2026-09-19T08:30:00+02:00'), '2026-09-19T06:30:00.000Z');
  });

  it('reads a spreadsheet datetime as UTC, not local', () => {
    // Without this the same file would import differently depending on where
    // it was opened.
    assert.equal(parseTimestamp('2026-09-19 10:04:00'), '2026-09-19T10:04:00.000Z');
  });

  it('rejects values that are not timestamps', () => {
    assert.equal(parseTimestamp('not a date'), null);
    assert.equal(parseTimestamp(''), null);
    assert.equal(parseTimestamp('2026'), null, 'a bare year is not a timestamp');
  });
});

describe('parseReadingsCsv', () => {
  const header = 'recorded_at,latitude,longitude,ambient_temp_c';

  it('parses a minimal valid file', () => {
    const result = parseReadingsCsv(
      `${header}\n2026-09-19T10:04:00Z,42.3398,-71.0892,18.4`,
      DEVICE,
    );

    assert.equal(result.issues.length, 0);
    assert.equal(result.readings.length, 1);

    const reading = result.readings[0]!;
    assert.equal(reading.device_id, DEVICE);
    assert.equal(reading.latitude, 42.3398);
    assert.equal(reading.ambient_temp_c, 18.4);
    assert.equal(reading.recorded_at, '2026-09-19T10:04:00.000Z');
  });

  it('refuses a file missing a required column', () => {
    const result = parseReadingsCsv('recorded_at,temperature\n2026-09-19T10:04:00Z,18', DEVICE);

    assert.equal(result.readings.length, 0);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0]!.message, /latitude, longitude/);
  });

  it('rejects a bad row but keeps the good ones', () => {
    const result = parseReadingsCsv(
      [
        header,
        '2026-09-19T10:00:00Z,42.3,-71.0,18.0',
        '2026-09-19T10:05:00Z,999,-71.0,18.1',
        '2026-09-19T10:10:00Z,42.3,-71.0,18.2',
      ].join('\n'),
      DEVICE,
    );

    assert.equal(result.readings.length, 2, 'one bad row does not sink the file');
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.line, 3, 'the line number points at the offending row');
    assert.equal(result.issues[0]!.field, 'latitude');
  });

  it('catches a psi value in a kPa column', () => {
    const result = parseReadingsCsv(
      'recorded_at,latitude,longitude,tire_fl_pressure_kpa\n2026-09-19T10:00:00Z,42.3,-71.0,2200',
      DEVICE,
    );

    assert.equal(result.readings.length, 0);
    assert.equal(result.issues[0]!.field, 'tire_fl_pressure_kpa');
    assert.match(result.issues[0]!.message, /plausible range/);
  });

  it('treats a blank optional value as absent rather than zero', () => {
    const result = parseReadingsCsv(`${header}\n2026-09-19T10:00:00Z,42.3,-71.0,`, DEVICE);

    assert.equal(result.readings.length, 1);
    assert.equal(
      result.readings[0]!.ambient_temp_c,
      null,
      'an empty cell must not become a real 0 °C reading',
    );
  });

  it('skips blank lines in the middle of a file without reporting them', () => {
    const result = parseReadingsCsv(
      `${header}\n2026-09-19T10:00:00Z,42.3,-71.0,18.0\n\n2026-09-19T10:05:00Z,42.3,-71.0,18.1`,
      DEVICE,
    );

    assert.equal(result.readings.length, 2);
    assert.equal(result.issues.length, 0);
  });

  it('keeps unrecognised columns against the reading', () => {
    const result = parseReadingsCsv(
      'recorded_at,lat,lon,rssi_dbm,driver\n2026-09-19T10:00:00Z,42.3,-71.0,-58,night-shift',
      DEVICE,
    );

    const extra = result.readings[0]!.extra;
    assert.equal(extra.rssi_dbm, -58, 'numeric extras are stored as numbers');
    assert.equal(extra.driver, 'night-shift');
  });

  it('strips thousands separators a spreadsheet may have added', () => {
    const result = parseReadingsCsv(
      'recorded_at,latitude,longitude,barometric_pressure_hpa\n2026-09-19T10:00:00Z,42.3,-71.0,"1,014.2"',
      DEVICE,
    );

    assert.equal(result.readings[0]!.barometric_pressure_hpa, 1014.2);
  });

  it('computes clock skew when both timestamps are present', () => {
    const result = parseReadingsCsv(
      'recorded_at,received_at,latitude,longitude\n2026-09-19T10:00:00Z,2026-09-19T10:00:02Z,42.3,-71.0',
      DEVICE,
    );

    assert.equal(result.readings[0]!.clock_skew_ms, 2000);
  });

  it('treats a lone timestamp as zero skew rather than inventing one', () => {
    const result = parseReadingsCsv(`${header}\n2026-09-19T10:00:00Z,42.3,-71.0,18`, DEVICE);
    assert.equal(result.readings[0]!.clock_skew_ms, 0);
  });

  it('caps the number of reported issues on a catastrophically bad file', () => {
    const rows = Array.from({ length: 500 }, () => '2026-09-19T10:00:00Z,999,-71.0,18');
    const result = parseReadingsCsv([header, ...rows].join('\n'), DEVICE);

    assert.equal(result.readings.length, 0);
    assert.ok(result.issues.length <= 100, `reported ${result.issues.length} issues`);
  });

  it('reports an empty file rather than throwing', () => {
    const result = parseReadingsCsv('', DEVICE);
    assert.equal(result.readings.length, 0);
    assert.equal(result.issues.length, 1);
  });
});

describe('round-tripping', () => {
  it('re-imports its own export unchanged', () => {
    const original = parseReadingsCsv(
      'recorded_at,latitude,longitude,ambient_temp_c,rssi_dbm\n2026-09-19T10:00:00Z,42.3398,-71.0892,18.4,-58',
      DEVICE,
    ).readings;

    const csv = toCsv(original, new Map([[DEVICE, 'Pico-01']]));
    const reimported = parseReadingsCsv(csv, 'other-device').readings;

    assert.equal(reimported.length, 1);
    const [before, after] = [original[0]!, reimported[0]!];

    assert.equal(after.id, before.id, 'the id is preserved, so a re-import updates in place');
    assert.equal(after.device_id, before.device_id, 'the exported device_id wins');
    assert.equal(after.recorded_at, before.recorded_at);
    assert.equal(after.latitude, before.latitude);
    assert.equal(after.ambient_temp_c, before.ambient_temp_c);
    assert.equal(after.extra.rssi_dbm, -58, 'extras survive the round trip');
  });

  it('parses its own template', () => {
    const result = parseReadingsCsv(templateCsv(), DEVICE);
    assert.equal(result.issues.length, 0, JSON.stringify(result.issues));
    assert.equal(result.readings.length, 2);
  });

  it('neutralises cells a spreadsheet would execute as a formula', () => {
    const readings = parseReadingsCsv(
      'recorded_at,latitude,longitude,note\n2026-09-19T10:00:00Z,42.3,-71.0,=cmd|calc',
      DEVICE,
    ).readings;

    const csv = toCsv(readings, new Map([[DEVICE, '=HYPERLINK("evil")']]));
    const cells = csv.split('\r\n')[1]!.split(',');

    // A device name is free text in its own cell, so it needs the apostrophe
    // guard or Excel will evaluate it on open.
    assert.ok(cells[2]!.startsWith(`"'=HYPERLINK`), 'formula-shaped device names are guarded');

    // Extras are serialised as a single JSON object, so a formula inside them
    // can never begin a cell — the cell begins with a brace.
    const extraCell = csv.slice(csv.lastIndexOf(',') + 1);
    assert.ok(extraCell.startsWith('"{'), 'extras are JSON-wrapped, not raw');
    assert.ok(!extraCell.startsWith('"='), 'an extra cannot start a cell with =');
    assert.ok(extraCell.includes('=cmd|calc'), 'the value itself is still preserved');
  });
});
