'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cdss = require('../lib/cdss');
const csv = require('../lib/csv');

test('mapRow maps a CHHS-style row into the facility schema', () => {
  const row = {
    'Facility Name': 'Sunny Elder Home',
    'Facility Number': '347001234',
    'Facility Status': 'LICENSED',
    'Facility Address': '123 Main St',
    'Facility City': 'Sacramento',
    'County Name': 'Sacramento',
    'Facility Zip': '95823',
    'Facility Capacity': '6',
  };
  const f = cdss.mapRow(row);
  assert.equal(f.name, 'Sunny Elder Home');
  assert.equal(f.ca_license_number, '347001234');
  assert.equal(f.license_status, 'licensed');
  assert.equal(f.city, 'Sacramento');
  assert.equal(f.capacity, 6);
  assert.equal(f.type, 'board_and_care_RCFE'); // capacity <= 6
  assert.equal(f.data_source, 'cdss');
});

test('mapRow infers assisted_living for larger capacity, normalizes status', () => {
  const f = cdss.mapRow({ 'Facility Name': 'Big AL', 'Facility Number': '999', 'Facility Status': 'Closed', 'Facility Capacity': '80' });
  assert.equal(f.type, 'assisted_living');
  assert.equal(f.license_status, 'closed');
});

test('mapRow drops rows missing name or license', () => {
  assert.equal(cdss.mapRow({ 'Facility Name': 'No License' }), null);
  assert.equal(cdss.mapRow({ 'Facility Number': '123' }), null);
});

test('mapViolation maps a citation row; summarize gives latest', () => {
  const v1 = cdss.mapViolation({ 'Facility Number': '347001234', Type: 'Type B', Date: '2023-01-10', Description: 'staffing' });
  const v2 = cdss.mapViolation({ 'Facility Number': '347001234', Type: 'Type A', Date: '2024-05-20', Description: 'medication' });
  assert.equal(v1.license, '347001234');
  assert.equal(cdss.mapViolation({ Type: 'X' }), null); // no license -> dropped
  const summary = cdss.summarizeViolations([v1, v2]);
  assert.match(summary, /2 citation/);
  assert.match(summary, /2024-05-20/); // latest first
  assert.match(summary, /medication/);
});

test('summarizeViolations is empty for no citations', () => {
  assert.equal(cdss.summarizeViolations([]), '');
});

test('csvToObjects auto-detects tab-separated spreadsheet paste', () => {
  const comma = 'Facility Name,Facility Number\nA Home,111';
  const tabbed = 'Facility Name\tFacility Number\nA Home\t111';
  assert.equal(csv.detectDelimiter(comma), ',');
  assert.equal(csv.detectDelimiter(tabbed), '\t');
  const o = csv.csvToObjects(tabbed)[0];
  assert.equal(o['Facility Name'], 'A Home');
  assert.equal(o['Facility Number'], '111');
  // And the mapper turns that pasted row into a facility.
  const f = cdss.mapRow(csv.csvToObjects(tabbed)[0]);
  assert.equal(f.name, 'A Home');
  assert.equal(f.ca_license_number, '111');
});

test('enabled() reflects env config', () => {
  const prev = process.env.CDSS_DATA_URL;
  delete process.env.CDSS_DATA_URL;
  delete process.env.CDSS_RESOURCE_ID;
  assert.equal(cdss.enabled(), false);
  process.env.CDSS_DATA_URL = 'https://example.com/rcfe.csv';
  assert.equal(cdss.enabled(), true);
  if (prev == null) delete process.env.CDSS_DATA_URL; else process.env.CDSS_DATA_URL = prev;
});
