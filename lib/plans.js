'use strict';

// California counties (all 58). State is CA-only for now.
const CA_COUNTIES = [
  'Alameda', 'Alpine', 'Amador', 'Butte', 'Calaveras', 'Colusa', 'Contra Costa',
  'Del Norte', 'El Dorado', 'Fresno', 'Glenn', 'Humboldt', 'Imperial', 'Inyo',
  'Kern', 'Kings', 'Lake', 'Lassen', 'Los Angeles', 'Madera', 'Marin', 'Mariposa',
  'Mendocino', 'Merced', 'Modoc', 'Mono', 'Monterey', 'Napa', 'Nevada', 'Orange',
  'Placer', 'Plumas', 'Riverside', 'Sacramento', 'San Benito', 'San Bernardino',
  'San Diego', 'San Francisco', 'San Joaquin', 'San Luis Obispo', 'San Mateo',
  'Santa Barbara', 'Santa Clara', 'Santa Cruz', 'Shasta', 'Sierra', 'Siskiyou',
  'Solano', 'Sonoma', 'Stanislaus', 'Sutter', 'Tehama', 'Trinity', 'Tulare',
  'Tuolumne', 'Ventura', 'Yolo', 'Yuba',
];

const STATES = [{ code: 'CA', name: 'California', counties: CA_COUNTIES }];

// Monthly price by number of counties.
const PRICE_BY_COUNT = { 1: 299, 2: 399, 3: 499 };
const MAX_COUNTIES = 3;

function priceFor(count) {
  return Object.prototype.hasOwnProperty.call(PRICE_BY_COUNT, count)
    ? PRICE_BY_COUNT[count]
    : null;
}

// Pricing tiers for display.
const TIERS = Object.entries(PRICE_BY_COUNT).map(([count, price]) => ({
  counties: Number(count),
  priceMonthly: price,
}));

module.exports = { STATES, CA_COUNTIES, PRICE_BY_COUNT, MAX_COUNTIES, TIERS, priceFor };
