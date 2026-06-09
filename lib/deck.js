'use strict';

/*
 * PowerPoint deck builder. Uses pptxgenjs, lazy-required so the rest of the app
 * stays dependency-free. Produces a per-hospital pitch deck: pain points, the
 * profile-matched "best fit" case, an illustrative savings estimate, and the ask.
 */

class DeckUnavailable extends Error {}

function getPptxGen() {
  let mod;
  try {
    mod = require('pptxgenjs');
  } catch {
    throw new DeckUnavailable('PowerPoint export needs pptxgenjs. Run: npm install pptxgenjs');
  }
  return mod.default || mod;
}

const NAVY = '1C2434';
const BLUE = '1F6FEB';
const GREEN = '0E9F6E';
const AMBER = 'B25E09';
const RED = 'B42318';
const GREY = '5B6577';

const STRENGTH_COLOR = { Strong: GREEN, Partial: AMBER, Gap: RED };

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US');
}

async function buildDeck({ agency, contact, hospital, role, facilityLabel, painPoints, strategy, savings }) {
  const PptxGenJS = getPptxGen();
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.author = agency || 'Senior Placement Agency';
  const W = 13.33;

  const where = [hospital.city, hospital.state].filter(Boolean).join(', ');
  const s = strategy || {};

  // --- Slide 1: Title ---
  let slide = pptx.addSlide();
  slide.background = { color: NAVY };
  slide.addText(agency || 'Senior Placement Agency', {
    x: 0.7, y: 2.2, w: 12, h: 0.6, fontSize: 20, color: 'FFFFFF', bold: true,
  });
  slide.addText(`Partnership proposal for\n${hospital.name}`, {
    x: 0.7, y: 2.9, w: 12, h: 1.6, fontSize: 34, color: 'FFFFFF', bold: true,
  });
  slide.addText([
    { text: `${role}${where ? ' · ' + where : ''}`, options: { fontSize: 16, color: 'C9D4E5' } },
  ], { x: 0.7, y: 4.6, w: 12, h: 0.5 });
  if (s.headline) {
    slide.addText(s.headline, { x: 0.7, y: 5.4, w: 12, h: 1, fontSize: 16, italic: true, color: 'A9C7FF' });
  }

  // --- Slide 2: Executive summary ---
  if (s.summary) {
    slide = pptx.addSlide();
    addHeading(slide, 'Executive summary');
    slide.addText(s.summary, { x: 0.7, y: 1.4, w: 12, h: 3, fontSize: 18, color: NAVY, lineSpacingMultiple: 1.3 });
    if (s.biggestStrength) {
      slide.addText([
        { text: 'Biggest strength: ', options: { bold: true, color: GREEN } },
        { text: s.biggestStrength, options: { color: NAVY } },
      ], { x: 0.7, y: 5.0, w: 12, h: 0.8, fontSize: 14 });
    }
  }

  // --- Slide 3: Their pain points ---
  if (painPoints && painPoints.length) {
    slide = pptx.addSlide();
    addHeading(slide, `Where ${role} feels the pressure`);
    const bullets = painPoints.map((p) => ({
      text: `${p.title}${p.description ? ' — ' + p.description : ''}`,
      options: {
        bullet: true, fontSize: 15, color: NAVY,
        paraSpaceAfter: 8,
      },
    }));
    slide.addText(bullets, { x: 0.7, y: 1.4, w: 12, h: 5 });
  }

  // --- Slide 4: Capability match (best fit) ---
  if (s.matches && s.matches.length) {
    slide = pptx.addSlide();
    addHeading(slide, 'How we solve them — the fit');
    const rows = [[
      { text: 'Their pain', options: headCell() },
      { text: 'How we help', options: headCell() },
      { text: 'Fit', options: headCell() },
    ]];
    for (const m of s.matches) {
      rows.push([
        { text: m.painPoint || '', options: bodyCell() },
        { text: m.howWeHelp || '', options: bodyCell() },
        { text: m.strength || '', options: { ...bodyCell(), color: 'FFFFFF', fill: { color: STRENGTH_COLOR[m.strength] || GREY }, align: 'center', bold: true } },
      ]);
    }
    slide.addTable(rows, {
      x: 0.7, y: 1.4, w: 12, colW: [4.2, 6.3, 1.5],
      border: { type: 'solid', color: 'E3E8F0', pt: 1 },
      valign: 'top', autoPage: true,
    });
  }

  // --- Slide 5: Estimated savings ---
  if (savings) {
    slide = pptx.addSlide();
    addHeading(slide, 'Estimated impact (illustrative)');
    slide.addText(money(savings.estimatedMonthly) + ' / month', {
      x: 0.7, y: 1.5, w: 7, h: 1, fontSize: 40, bold: true, color: GREEN,
    });
    slide.addText('≈ ' + money(savings.estimatedAnnual) + ' / year', {
      x: 0.7, y: 2.5, w: 7, h: 0.6, fontSize: 20, color: NAVY,
    });
    const basis = `${savings.avoidedDaysPerCase} avoidable day(s)/case × ${savings.casesPerMonth} hard-to-place case(s)/month × ${money(savings.costPerDay)}/inpatient day`;
    slide.addText([
      { text: 'Driver: ', options: { bold: true } },
      { text: savings.driver || 'avoidable bed-days', options: {} },
    ], { x: 0.7, y: 3.4, w: 12, h: 0.5, fontSize: 14, color: NAVY });
    slide.addText([
      { text: 'Basis: ', options: { bold: true } },
      { text: basis, options: {} },
    ], { x: 0.7, y: 3.9, w: 12, h: 0.5, fontSize: 14, color: NAVY });
    slide.addText(savings.disclaimer || 'Illustrative industry estimate to validate against your own data — not a guaranteed result.', {
      x: 0.7, y: 5.6, w: 12, h: 1, fontSize: 12, italic: true, color: AMBER,
    });
  }

  // --- Slide 6: Why us + objections ---
  if ((s.talkingPoints && s.talkingPoints.length) || (s.objections && s.objections.length)) {
    slide = pptx.addSlide();
    addHeading(slide, 'Why us');
    const tp = (s.talkingPoints || []).map((t) => ({ text: t, options: { bullet: true, fontSize: 14, color: NAVY, paraSpaceAfter: 6 } }));
    if (tp.length) slide.addText(tp, { x: 0.7, y: 1.4, w: 12, h: 2.6 });
    const obj = (s.objections || []).flatMap((o) => ([
      { text: `“${o.objection}”`, options: { bold: true, fontSize: 13, color: BLUE, paraSpaceBefore: 6 } },
      { text: o.response, options: { fontSize: 13, color: GREY, paraSpaceAfter: 4 } },
    ]));
    if (obj.length) slide.addText(obj, { x: 0.7, y: 4.1, w: 12, h: 3 });
  }

  // --- Slide 7: The ask + compliance ---
  slide = pptx.addSlide();
  addHeading(slide, 'Next step');
  if (s.suggestedFirstStep) {
    slide.addText(s.suggestedFirstStep, { x: 0.7, y: 1.4, w: 12, h: 1.6, fontSize: 18, color: NAVY, lineSpacingMultiple: 1.3 });
  }
  const comp = (s.complianceNotes || []).map((c) => ({ text: c, options: { bullet: true, fontSize: 12, color: GREY, paraSpaceAfter: 4 } }));
  if (comp.length) {
    slide.addText('Compliance & disclosures', { x: 0.7, y: 3.3, w: 12, h: 0.4, fontSize: 14, bold: true, color: NAVY });
    slide.addText(comp, { x: 0.7, y: 3.8, w: 12, h: 2.5 });
  }
  slide.addText(
    [
      { text: agency || 'Senior Placement Agency', options: { bold: true, color: NAVY } },
      ...(contact ? [{ text: `  ·  ${contact}`, options: { color: GREY } }] : []),
    ],
    { x: 0.7, y: 6.7, w: 12, h: 0.5, fontSize: 12 }
  );

  return await pptx.write({ outputType: 'nodebuffer' });
}

function addHeading(slide, text) {
  slide.addText(text, { x: 0.7, y: 0.5, w: 12, h: 0.7, fontSize: 26, bold: true, color: NAVY });
  slide.addShape('line', { x: 0.7, y: 1.25, w: 12, h: 0, line: { color: BLUE, width: 2 } });
}

function headCell() {
  return { fill: { color: NAVY }, color: 'FFFFFF', bold: true, fontSize: 12, valign: 'middle' };
}

function bodyCell() {
  return { color: '1C2434', fontSize: 11, valign: 'top' };
}

module.exports = { buildDeck, DeckUnavailable };
