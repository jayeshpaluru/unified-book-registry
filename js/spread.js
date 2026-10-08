export const SPREAD_MIN_WIDTH = 800;

export const wantsSpread = (w, h) => w > h && w >= SPREAD_MIN_WIDTH;

// Groups page indices into screens. Each group is in ascending page order.
export function buildSpreads(count, { spread, coverSingle }) {
  const groups = [];
  let i = 0;
  if (spread && coverSingle && count > 0) groups.push([i++]);
  while (i < count) {
    groups.push(spread && i + 1 < count ? [i, i + 1] : [i]);
    i += spread ? 2 : 1;
  }
  return groups;
}

export const spreadIndexOf = (groups, page) =>
  Math.max(0, groups.findIndex((g) => g.includes(page)));

// Left-to-right visual order of a group on screen.
export const visualOrder = (group, rtl) => (rtl ? [...group].reverse() : group);
