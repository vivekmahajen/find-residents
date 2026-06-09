'use strict';

/*
 * Your agency profile. The Outreach Strategist agent uses this to make a
 * tailored, compliant case to each referral source. Edit these to match your
 * business — they feed directly into the AI prompts.
 */
module.exports = {
  agencyName: 'Affordable Golden Years',
  serviceArea: 'California (Sacramento County focus)',
  levelsOfCare: ['assisted living', 'board & care / RCFE', 'memory care'],
  payors: ['private pay', 'LTC insurance', 'Medi-Cal', 'Assisted Living Waiver (ALW)'],
  differentiators: [
    'Medi-Cal & board-and-care capable (places the hard, low-income cases)',
    'same-day response, evenings/weekends reachable',
    'bilingual',
    'owns the legwork: tours, options, paperwork',
  ],
  // Disclosed per California RCFE referral-source law — keep this honest.
  feeModel: "Paid by facilities (one month's rent). No fee charged to families.",
};
