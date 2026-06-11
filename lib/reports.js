'use strict';

/*
 * Pure reporting/analytics over the event log (records of kind 'event').
 * Each event: { agencyId, createdAt, data: { type, entityRef, metadata } }.
 */

const DAY = 24 * 60 * 60 * 1000;

function rate(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0; // percent, 1 decimal
}

// Per-agency placement funnel + conversions + leaderboard.
function buildReport(events, { now = Date.now(), days = 30 } = {}) {
  const since = days && days > 0 ? now - days * DAY : 0;
  const ev = events.filter((e) => e.createdAt >= since);
  const byType = (t) => ev.filter((e) => e.data.type === t);

  const sourcesContacted = new Set(byType('contact_added').map((e) => e.data.entityRef).filter(Boolean)).size;
  const leadsReceived = byType('lead_created').length;
  const tours = byType('tour_scheduled').length;
  const applications = byType('application').length;
  const placements = byType('placement_made').length;

  // Time-to-placement: match lead_created → placement_made by entityRef (leadId).
  const createdAtByLead = {};
  for (const e of byType('lead_created')) createdAtByLead[e.data.entityRef] = e.createdAt;
  const ttp = [];
  for (const e of byType('placement_made')) {
    const c = createdAtByLead[e.data.entityRef];
    if (c) ttp.push((e.createdAt - c) / DAY);
  }
  const timeToPlacementDays = ttp.length ? Math.round((ttp.reduce((a, b) => a + b, 0) / ttp.length) * 10) / 10 : null;

  // Source leaderboard: placements + revenue grouped by referring source.
  const bySource = {};
  for (const e of byType('placement_made')) {
    const src = (e.data.metadata && e.data.metadata.source) || 'Unattributed';
    bySource[src] = bySource[src] || { source: src, placements: 0, revenue: 0 };
    bySource[src].placements += 1;
    bySource[src].revenue += Number((e.data.metadata && e.data.metadata.revenue) || 0);
  }
  const sourceLeaderboard = Object.values(bySource).sort((a, b) => b.placements - a.placements || b.revenue - a.revenue);

  const totalRevenue = sourceLeaderboard.reduce((a, b) => a + b.revenue, 0);

  return {
    period: { days, since },
    funnel: { sourcesContacted, leadsReceived, tours, applications, placements },
    conversions: {
      contactToLead: rate(leadsReceived, sourcesContacted),
      leadToTour: rate(tours, leadsReceived),
      tourToApplication: rate(applications, tours),
      applicationToPlacement: rate(placements, applications),
      leadToPlacement: rate(placements, leadsReceived),
    },
    timeToPlacementDays,
    sourceLeaderboard,
    activity: {
      searches: byType('source_searched').length,
      activitiesLogged: byType('activity_logged').length,
      casesGenerated: byType('case_generated').length,
      decksBuilt: byType('deck_built').length,
      emailsSent: byType('email_sent').length,
      sequencesEnrolled: byType('sequence_enrolled').length,
      matchesRun: byType('match_run').length,
    },
    revenue: { total: totalRevenue, perPlacement: placements ? Math.round((totalRevenue / placements) * 100) / 100 : 0 },
  };
}

// Cross-agency engagement (admin only) — measures weekly-active design partners.
function buildAdminUsage(events, users, now = Date.now()) {
  const weekAgo = now - 7 * DAY;
  const byAgency = {};
  for (const e of events) {
    const a = (byAgency[e.agencyId] = byAgency[e.agencyId] || { total: 0, last7: 0, lastActive: 0, features: new Set() });
    a.total += 1;
    a.lastActive = Math.max(a.lastActive, e.createdAt);
    a.features.add(e.data.type);
    if (e.createdAt >= weekAgo) a.last7 += 1;
  }
  const agencies = users.map((u) => {
    const a = byAgency[u.id] || { total: 0, last7: 0, lastActive: 0, features: new Set() };
    return {
      username: u.username,
      email: u.email,
      totalEvents: a.total,
      eventsLast7: a.last7,
      lastActive: a.lastActive || null,
      features: [...a.features].sort(),
    };
  }).sort((x, y) => y.eventsLast7 - x.eventsLast7 || (y.lastActive || 0) - (x.lastActive || 0));

  const weeklyActiveAgencies = agencies.filter((a) => a.eventsLast7 > 0).length;
  return { weeklyActiveAgencies, totalAgencies: users.length, agencies };
}

module.exports = { buildReport, buildAdminUsage };
