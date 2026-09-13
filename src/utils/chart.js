'use strict';

const { escapeHtml } = require('./escape');

/**
 * Server-rendered SVG charts.
 *
 * The control panel draws its own charts rather than pulling in a library:
 * the data is small, the shapes are simple, and a server-rendered SVG needs
 * no script, survives a strict CSP and prints. Colours come from CSS classes
 * so both themes and a custom accent still work.
 */

const PAD = { top: 8, right: 8, bottom: 18, left: 30 };

function niceCeiling(max) {
  if (max <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = magnitude * step;
    if (candidate >= max) return candidate;
  }
  return magnitude * 10;
}

/**
 * A dual-series line chart with a filled area under the first series.
 *
 * @param {Array<object>} rows
 * @param {object} options
 *   x        - key holding the label
 *   series   - [{ key, name, className }]
 *   width, height
 */
function lineChart(rows, { x, series, width = 660, height = 180 } = {}) {
  if (!rows || rows.length === 0) {
    return '<p class="chart-empty">Nothing recorded yet.</p>';
  }

  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const peak = Math.max(1, ...rows.flatMap((row) => series.map((s) => Number(row[s.key]) || 0)));
  const top = niceCeiling(peak);
  const stepX = rows.length > 1 ? innerW / (rows.length - 1) : 0;

  const px = (i) => PAD.left + i * stepX;
  const py = (v) => PAD.top + innerH - (Math.min(v, top) / top) * innerH;

  // Horizontal guides at 0, half and full scale, each labelled with its value.
  let grid = '';
  for (const fraction of [0, 0.5, 1]) {
    const value = Math.round(top * fraction);
    const y = py(value);
    grid +=
      `<line class="chart-grid" x1="${PAD.left}" y1="${y.toFixed(1)}" ` +
      `x2="${(width - PAD.right).toFixed(1)}" y2="${y.toFixed(1)}"/>` +
      `<text class="chart-axis" x="${PAD.left - 6}" y="${(y + 3.5).toFixed(1)}" ` +
      `text-anchor="end">${value}</text>`;
  }

  let paths = '';
  series.forEach((s, index) => {
    const points = rows.map((row, i) => `${px(i).toFixed(1)},${py(Number(row[s.key]) || 0).toFixed(1)}`);
    if (index === 0) {
      const area =
        `M${px(0).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${points.join(' L')} ` +
        `L${px(rows.length - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`;
      paths += `<path class="chart-area ${s.className}" d="${area}"/>`;
    }
    paths += `<polyline class="chart-line ${s.className}" points="${points.join(' ')}"/>`;
    // Emphasise where the series ends - the number that matters most.
    const last = points[points.length - 1].split(',');
    paths += `<circle class="chart-dot ${s.className}" cx="${last[0]}" cy="${last[1]}" r="3"/>`;
  });

  // First, middle and last labels only; a tick per day is unreadable at 660px.
  const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
  let labels = '';
  for (const i of labelIndexes) {
    const anchor = i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle';
    labels +=
      `<text class="chart-axis" x="${px(i).toFixed(1)}" y="${height - 5}" ` +
      `text-anchor="${anchor}">${escapeHtml(rows[i][x])}</text>`;
  }

  return (
    `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" ` +
    `aria-label="${escapeHtml(series.map((s) => s.name).join(' and '))} over the last ${rows.length} days">` +
    `${grid}${paths}${labels}</svg>`
  );
}

/** A bare sparkline for a stat tile. */
function sparkline(values, { className = 'chart-a', width = 108, height = 26 } = {}) {
  const list = (values || []).map((v) => Number(v) || 0);
  if (list.length < 2) return '';
  const top = Math.max(1, ...list);
  const stepX = width / (list.length - 1);
  const points = list.map((v, i) => `${(i * stepX).toFixed(1)},${(height - (v / top) * (height - 3) - 1).toFixed(1)}`);
  return (
    `<svg class="sparkline" viewBox="0 0 ${width} ${height}" aria-hidden="true">` +
    `<polyline class="chart-line ${className}" points="${points.join(' ')}"/></svg>`
  );
}

module.exports = { lineChart, sparkline };
