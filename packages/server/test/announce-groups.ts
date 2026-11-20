/**
 * Announcement groups for tests, written as the rules they replaced: each one
 * a group with its events on, from its sources, said at its destinations.
 */
export type RuleLike = { events: string[]; sources?: string[]; to?: string[]; staff?: boolean; templates?: Record<string, string> };

export const groupsOf = (rules: RuleLike[]) => rules.map((rule, index) => ({
  id: `group-${index + 1}`,
  name: `播报组 ${index + 1}`,
  to: rule.to ?? [],
  staff: rule.staff ?? false,
  events: Object.fromEntries(rule.events.map((key) => [key, { on: true, sources: rule.sources ?? [] }])),
  templates: rule.templates ?? {},
}));
