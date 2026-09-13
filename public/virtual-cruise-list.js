/* Keep the complete sorted result list in memory, with only nearby rows in DOM. */
window.createVirtualCruiseList = function ({ body, list, renderRow, onRowsChanged }) {
  const table = body.closest('table');
  const shell = body.closest('.view-shell');
  const overscan = 8;
  let disposed = false, frame = 0, start = -1, end = -1, width = 0;
  let heights, offsets;
  const rows = new Map();
  const makeSpacer = () => {
    const row = document.createElement('tr');
    row.className = 'virtual-spacer';
    row.setAttribute('aria-hidden', 'true');
    row.innerHTML = '<td colspan="18"></td>';
    return row;
  };
  const before = makeSpacer(), after = makeSpacer();
  body.replaceChildren(before, after);
  body.classList.add('is-virtual');
  table.setAttribute('aria-rowcount', String(list.length + 2));

  function rebuildOffsets() {
    offsets = [0];
    for (const height of heights) offsets.push(offsets[offsets.length - 1] + height);
  }
  function indexAt(y) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, list.length - 1);
  }
  function setSpace(row, height) {
    row.firstChild.style.height = `${Math.max(0, height)}px`;
  }
  function update() {
    frame = 0;
    if (disposed || document.querySelector('dialog[open]')) return;
    const nextWidth = shell.getBoundingClientRect().width;
    const resized = nextWidth !== width;
    if (resized) {
      width = nextWidth;
      heights = Array(list.length).fill(width <= 480 ? 440 : 112);
      rebuildOffsets();
    }
    const top = body.getBoundingClientRect().top + window.scrollY;
    const y = Math.max(0, window.scrollY - top);
    const anchor = indexAt(y);
    const oldAnchorOffset = offsets[anchor];
    const nextStart = Math.max(0, anchor - overscan);
    const nextEnd = Math.min(list.length, indexAt(y + window.innerHeight) + overscan + 1);
    const changed = nextStart !== start || nextEnd !== end;
    start = nextStart; end = nextEnd;
    if (changed) {
      for (const [index, row] of rows) {
        if (index < start || index >= end) {
          rowObserver?.unobserve(row);
          row.remove();
          rows.delete(index);
        }
      }
      let cursor = before.nextSibling;
      for (let index = start; index < end; index++) {
        let row = rows.get(index);
        if (!row) {
          const template = document.createElement('template');
          template.innerHTML = renderRow(list[index], index);
          row = template.content.firstElementChild;
          row.dataset.virtualIndex = String(index);
          row.setAttribute('aria-rowindex', String(index + 3));
          rows.set(index, row);
          body.insertBefore(row, cursor);
          rowObserver?.observe(row);
        }
        cursor = row.nextSibling;
      }
    }
    setSpace(before, offsets[start]);
    setSpace(after, offsets[list.length] - offsets[end]);
    let measured = false;
    for (const [index, row] of rows) {
      const style = getComputedStyle(row);
      const height = row.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      if (height > 0 && Math.abs(heights[index] - height) > 0.5) {
        heights[index] = height;
        measured = true;
      }
    }
    if (measured) {
      rebuildOffsets();
      setSpace(before, offsets[start]);
      setSpace(after, offsets[list.length] - offsets[end]);
      // Keep the visible cruise still when estimates above it become exact.
      if (window.scrollY >= top) window.scrollBy(0, offsets[anchor] - oldAnchorOffset);
      schedule();
    }
    if (changed) onRowsChanged();
  }
  function schedule() {
    if (!disposed && !frame) frame = requestAnimationFrame(update);
  }
  const rowObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  const shellObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  shellObserver?.observe(shell);
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  document.addEventListener('close', schedule, true);
  update();
  return {
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      rowObserver?.disconnect();
      shellObserver?.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('close', schedule, true);
      body.classList.remove('is-virtual');
      table.removeAttribute('aria-rowcount');
    },
  };
};
