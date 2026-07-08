const SIZE = 13;
const CENTER = Math.floor(SIZE / 2);

const dirs = [
  { key: "top", dx: 0, dy: -1, opposite: "bottom", name: "上" },
  { key: "right", dx: 1, dy: 0, opposite: "left", name: "右" },
  { key: "bottom", dx: 0, dy: 1, opposite: "top", name: "下" },
  { key: "left", dx: -1, dy: 0, opposite: "right", name: "左" },
];

const roomTypes = [
  { id: "start", name: "出生房", short: "生", category: "start" },
  { id: "normal", name: "普通", short: "普", category: "normal" },
  { id: "shop", name: "商店", short: "店", category: "shop" },
  { id: "special", name: "特殊房", short: "特", category: "special" },
  { id: "miniboss", name: "小Boss", short: "小", category: "miniboss" },
  { id: "curse", name: "诅咒房", short: "咒", category: "curse" },
  { id: "boss", name: "Boss", short: "王", category: "boss" },
  { id: "secret", name: "已知隐藏", short: "隐", category: "secret" },
  { id: "super", name: "已知超隐", short: "超", category: "secret" },
];

const state = {
  selectedRoom: null,
  eraseMode: false,
  selectedWalls: new Set(),
  fusionSelection: new Set(),
  selectedCells: new Set(),
  selectionMode: false,
  drag: null,
  suppressClick: false,
  nextGroupId: 1,
  history: [],
  cells: new Map(),
  candidates: new Map(),
};

const grid = document.getElementById("grid");
const legend = document.getElementById("legend");
const roomTools = document.getElementById("roomTools");
const resultLists = document.getElementById("resultLists");
const summary = document.getElementById("summary");
const template = document.getElementById("resultTemplate");
const fusionSelectionInfo = document.getElementById("fusionSelectionInfo");

function keyOf(x, y) {
  return `${x},${y}`;
}

function parseKey(key) {
  return key.split(",").map(Number);
}

function coordName(x, y) {
  const east = x - CENTER;
  const south = y - CENTER;
  if (east === 0 && south === 0) return "中心";
  const parts = [];
  if (east !== 0) parts.push(`${Math.abs(east)}${east > 0 ? "右" : "左"}`);
  if (south !== 0) parts.push(`${Math.abs(south)}${south > 0 ? "下" : "上"}`);
  return parts.join(" ");
}

function ensureCell(x, y) {
  const key = keyOf(x, y);
  if (!state.cells.has(key)) state.cells.set(key, { type: null, walls: new Set(), groupId: null });
  return state.cells.get(key);
}

function snapshotState() {
  return {
    selectedRoom: state.selectedRoom,
    eraseMode: state.eraseMode,
    selectedWalls: [...state.selectedWalls],
    fusionSelection: [...state.fusionSelection],
    selectedCells: [...state.selectedCells],
    selectionMode: state.selectionMode,
    nextGroupId: state.nextGroupId,
    cells: [...state.cells].map(([key, cell]) => [
      key,
      { type: cell.type, groupId: cell.groupId, walls: [...cell.walls] },
    ]),
  };
}

function restoreSnapshot(snapshot) {
  state.selectedRoom = snapshot.selectedRoom;
  state.eraseMode = snapshot.eraseMode;
  state.selectedWalls = new Set(snapshot.selectedWalls);
  state.fusionSelection = new Set(snapshot.fusionSelection);
  state.selectedCells = new Set(snapshot.selectedCells);
  state.selectionMode = snapshot.selectionMode;
  state.nextGroupId = snapshot.nextGroupId;
  state.cells = new Map(snapshot.cells.map(([key, cell]) => [
    key,
    { type: cell.type, groupId: cell.groupId, walls: new Set(cell.walls) },
  ]));
  state.candidates.clear();
  resultLists.innerHTML = "";
  summary.textContent = "已撤回一步，点击“确认并分析”刷新生成指标。";
  syncTools();
  renderGrid();
}

function pushHistory() {
  state.history.push(snapshotState());
  if (state.history.length > 80) state.history.shift();
}

function undo() {
  const snapshot = state.history.pop();
  if (!snapshot) {
    summary.textContent = "没有可撤回的操作。";
    return;
  }
  restoreSnapshot(snapshot);
}

function clearExistingStart() {
  for (const cell of state.cells.values()) {
    if (cell.type !== "start") continue;
    cell.type = null;
    cell.groupId = null;
    cell.walls.clear();
  }
}

function getCell(x, y) {
  return state.cells.get(keyOf(x, y));
}

function inBounds(x, y) {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

function isRoom(cell) {
  return Boolean(cell && cell.type);
}

function roomMeta(type) {
  return roomTypes.find((room) => room.id === type);
}

function labelFor(type) {
  return roomMeta(type)?.name || "空";
}

function groupIdFor(x, y, cell = getCell(x, y)) {
  if (!isRoom(cell)) return null;
  return cell.groupId || keyOf(x, y);
}

function isBossLike(cell) {
  return cell && roomMeta(cell.type)?.category === "boss";
}

function blocksUltra(cell) {
  return Boolean(cell && ["curse", "boss", "secret", "super"].includes(cell.type));
}

function countsForSecret(cell) {
  return Boolean(cell && !["boss", "secret", "super"].includes(cell.type));
}

function countsForSuper(cell) {
  return Boolean(cell && cell.type === "normal");
}

function countsForUltra(cell) {
  return Boolean(cell && !blocksUltra(cell));
}

function passableBetween(x, y, dir) {
  if (!document.getElementById("useBlocked").checked) return true;
  const here = getCell(x, y);
  const nx = x + dir.dx;
  const ny = y + dir.dy;
  const there = getCell(nx, ny);
  return !(here && here.walls.has(dir.key)) && !(there && there.walls.has(dir.opposite));
}

function adjacentRooms(x, y, filter = () => true) {
  const byGroup = new Map();
  for (const dir of dirs) {
    const nx = x + dir.dx;
    const ny = y + dir.dy;
    const cell = getCell(nx, ny);
    if (!inBounds(nx, ny) || !isRoom(cell) || !filter(cell, dir, nx, ny)) continue;
    const back = { ...dir, dx: -dir.dx, dy: -dir.dy, key: dir.opposite, opposite: dir.key };
    if (!passableBetween(nx, ny, back)) continue;
    const groupId = groupIdFor(nx, ny, cell);
    if (!byGroup.has(groupId)) byGroup.set(groupId, { x: nx, y: ny, cell, dir, groupId });
  }
  return [...byGroup.values()];
}

function blockedByAnyRoomWall(x, y) {
  if (!document.getElementById("useBlocked").checked) return false;
  return dirs.some((dir) => {
    const nx = x + dir.dx;
    const ny = y + dir.dy;
    const cell = getCell(nx, ny);
    if (!inBounds(nx, ny) || !isRoom(cell)) return false;
    const back = { ...dir, dx: -dir.dx, dy: -dir.dy, key: dir.opposite, opposite: dir.key };
    return !passableBetween(nx, ny, back);
  });
}

function touchesAnyRoom(x, y) {
  return dirs.some((dir) => {
    const nx = x + dir.dx;
    const ny = y + dir.dy;
    return inBounds(nx, ny) && isRoom(getCell(nx, ny));
  });
}

function roomGroups() {
  const groups = new Map();
  for (const [key, cell] of state.cells) {
    if (!isRoom(cell)) continue;
    const [x, y] = parseKey(key);
    const groupId = groupIdFor(x, y, cell);
    if (!groups.has(groupId)) groups.set(groupId, { id: groupId, type: cell.type, cells: [] });
    groups.get(groupId).cells.push({ x, y, cell });
  }
  return groups;
}

function groupNeighbors(group, groups) {
  const neighbors = new Map();
  for (const { x, y } of group.cells) {
    for (const dir of dirs) {
      const nx = x + dir.dx;
      const ny = y + dir.dy;
      const cell = getCell(nx, ny);
      if (!inBounds(nx, ny) || !isRoom(cell) || !passableBetween(x, y, dir)) continue;
      const neighborId = groupIdFor(nx, ny, cell);
      if (neighborId === group.id) continue;
      if (!neighbors.has(neighborId)) neighbors.set(neighborId, groups.get(neighborId));
    }
  }
  return [...neighbors.values()].filter(Boolean);
}

function findStartGroup(groups) {
  for (const group of groups.values()) {
    if (group.cells.some(({ cell }) => cell.type === "start")) return group.id;
  }
  const centerCell = getCell(CENTER, CENTER);
  if (isRoom(centerCell)) return groupIdFor(CENTER, CENTER, centerCell);
  return groups.keys().next().value || null;
}

function distanceMapFromStart() {
  const groups = roomGroups();
  const startGroupId = findStartGroup(groups);
  const distances = new Map();
  if (!startGroupId) return distances;

  const queue = [startGroupId];
  distances.set(startGroupId, 0);
  for (let i = 0; i < queue.length; i++) {
    const group = groups.get(queue[i]);
    const currentDistance = distances.get(group.id);
    for (const next of groupNeighbors(group, groups)) {
      if (distances.has(next.id)) continue;
      distances.set(next.id, currentDistance + 1);
      queue.push(next.id);
    }
  }
  return distances;
}

function nearestShopDistance(distances) {
  let best = null;
  for (const group of roomGroups().values()) {
    if (!group.cells.some(({ cell }) => cell.type === "shop")) continue;
    const distance = distances.get(group.id);
    if (distance == null) continue;
    best = best == null ? distance : Math.min(best, distance);
  }
  return best;
}

function blockedReasonForSecret(x, y) {
  if (isRoom(getCell(x, y))) return "已有房间";
  if (blockedByAnyRoomWall(x, y)) return "贴着堵墙边";
  if (document.getElementById("strictSpecial").checked) {
    const bad = adjacentRooms(x, y, (cell) => ["boss", "secret", "super"].includes(cell.type));
    if (bad.length) return "贴近 Boss/已知隐藏";
  }
  return "";
}

function secretWeightRange(adjacentCount) {
  const penalty = adjacentCount === 1 ? 6 : adjacentCount === 2 ? 3 : 0;
  return { min: 10 - penalty, max: 14 - penalty };
}

function scoreSecret(x, y) {
  const reason = blockedReasonForSecret(x, y);
  if (reason) return null;
  const adj = adjacentRooms(x, y, countsForSecret);
  if (!adj.length) return null;

  const range = secretWeightRange(adj.length);
  return {
    x,
    y,
    minWeight: range.min,
    maxWeight: range.max,
    sortValue: range.max * 100 + adj.length,
    gridMark: `W${range.min}-${range.max}`,
    text: `权重 ${range.min}-${range.max}，邻接 ${adj.length} 个房间`,
    detail: `基础 10-14；${adj.length === 1 ? "1 邻接扣 6" : adj.length === 2 ? "2 邻接扣 3" : "3/4 邻接不扣"}。邻接：${adj.map(({ x: ax, y: ay, cell }) => `${coordName(ax, ay)}(${labelFor(cell.type)})`).join("、")}`,
  };
}

function filterDominatedSecrets(candidates) {
  if (!candidates.length) return candidates;
  const bestLowerBound = Math.max(...candidates.map((item) => item.minWeight));
  return candidates.filter((item) => item.maxWeight >= bestLowerBound);
}

function allDeadEndCandidates(distances) {
  const candidates = [];
  for (const { x, y } of allEmptyPositions()) {
    if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) continue;
    if (blockedByAnyRoomWall(x, y)) continue;
    const adj = adjacentRooms(x, y);
    if (adj.length !== 1) continue;
    const anchor = adj[0];
    const anchorDistance = distances.get(anchor.groupId);
    candidates.push({
      x,
      y,
      anchor,
      distance: anchorDistance == null ? null : anchorDistance + 1,
      isSuperLegal: countsForSuper(anchor.cell),
    });
  }
  candidates.sort((a, b) => {
    const ad = a.distance == null ? -1 : a.distance;
    const bd = b.distance == null ? -1 : b.distance;
    if (bd !== ad) return bd - ad;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });
  candidates.forEach((item, index) => {
    item.deadEndRank = index + 1;
  });
  return candidates;
}

function scoreSuper(deadEnd, context) {
  if (!deadEnd.isSuperLegal) return null;
  const distance = deadEnd.distance;
  if (
    context.lunaMode &&
    context.shopDistance != null &&
    distance != null &&
    distance < context.shopDistance
  ) {
    return null;
  }
  return {
    x: deadEnd.x,
    y: deadEnd.y,
    sortValue: distance == null ? -1 : distance,
    gridMark: distance == null ? `D?/#${deadEnd.deadEndRank}` : `D${distance}/#${deadEnd.deadEndRank}`,
    text: distance == null
      ? `死路序号 #${deadEnd.deadEndRank}，距离未知`
      : `死路序号 #${deadEnd.deadEndRank}，到出生房距离 ${distance}`,
    detail: `挂在 ${coordName(deadEnd.anchor.x, deadEnd.anchor.y)}(${labelFor(deadEnd.anchor.cell.type)})；超隐只把普通房当合法锚点，窄/小房请用堵墙表达无效门位`,
  };
}

function markSuperSlots(items, lunaMode, shopDistance) {
  const slotCount = lunaMode ? 2 : 1;
  return items.map((item, index) => {
    if (index >= slotCount) {
      return {
        ...item,
        detail: `${item.detail}${lunaMode ? "；Luna 开启时前两个合法死路是两个超隐槽位" : ""}`,
      };
    }
    const slotLabel = lunaMode ? `L${index + 1}` : "超隐槽位";
    const shopNote = lunaMode && shopDistance != null
      ? `；已知商店按第 4 远参考，商店距离 D${shopDistance}`
      : "";
    return {
      ...item,
      gridMark: lunaMode ? `${item.gridMark}/${slotLabel}` : item.gridMark,
      text: lunaMode ? `${item.text}，Luna 超隐槽位 ${index + 1}` : `${item.text}，最优超隐槽位`,
      detail: `${item.detail}；${slotLabel}${shopNote}`,
    };
  });
}

function redRoomValid(x, y, fromUltraDir) {
  if (!inBounds(x, y) || isRoom(getCell(x, y))) return false;
  if (blockedByAnyRoomWall(x, y)) return false;
  const adj = adjacentRooms(x, y, (cell, dir) => {
    if (dir.key === fromUltraDir.opposite) return false;
    if (document.getElementById("voidMode").checked && cell.type === "boss") return true;
    return countsForUltra(cell);
  });
  return adj.length > 0;
}

function touchesBlockedRedRoomSlot(x, y) {
  return dirs.some((dir) => {
    const rx = x + dir.dx;
    const ry = y + dir.dy;
    return inBounds(rx, ry) && !isRoom(getCell(rx, ry)) && blockedByAnyRoomWall(rx, ry);
  });
}

function scoreUltra(x, y) {
  if (isRoom(getCell(x, y))) return null;
  if (touchesAnyRoom(x, y)) return null;
  if (touchesBlockedRedRoomSlot(x, y)) return null;

  const links = [];
  const touchedRooms = new Set();
  for (const dir of dirs) {
    const rx = x + dir.dx;
    const ry = y + dir.dy;
    if (!redRoomValid(rx, ry, dir)) continue;
    const redAdj = adjacentRooms(rx, ry, (cell, roomDir) => {
      if (roomDir.key === dir.opposite) return false;
      if (document.getElementById("voidMode").checked && cell.type === "boss") return true;
      return countsForUltra(cell);
    });
    for (const room of redAdj) touchedRooms.add(room.groupId);
    links.push({ x: rx, y: ry });
  }

  if (!links.length) return null;
  const roomCount = touchedRooms.size;
  return {
    x,
    y,
    sortValue: roomCount * 100 + links.length,
    gridMark: `R${roomCount}`,
    text: `通过红房连接 ${roomCount} 个非红房`,
    detail: `3+ 优先于 2，2 优先于 1。红房点：${links.map((room) => coordName(room.x, room.y)).join("、")}`,
  };
}

function allEmptyPositions() {
  const list = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!isRoom(getCell(x, y))) list.push({ x, y });
    }
  }
  return list;
}

function analyze() {
  const distances = distanceMapFromStart();
  const shopDistance = nearestShopDistance(distances);
  const deadEnds = allDeadEndCandidates(distances);
  const lunaMode = document.getElementById("lunaMode").checked;
  const secret = [];
  const superSecret = [];
  const ultra = [];

  for (const { x, y } of allEmptyPositions()) {
    const s = scoreSecret(x, y);
    const u = scoreUltra(x, y);
    if (s) secret.push(s);
    if (u) ultra.push(u);
  }

  for (const deadEnd of deadEnds) {
    const ss = scoreSuper(deadEnd, { lunaMode, shopDistance });
    if (ss) superSecret.push(ss);
  }

  const byMetric = (items) => items.sort((a, b) => b.sortValue - a.sortValue);
  const sortedSuper = byMetric(superSecret);
  renderResults({
    secret: byMetric(filterDominatedSecrets(secret)),
    superSecret: markSuperSlots(sortedSuper, lunaMode, shopDistance),
    ultra: byMetric(ultra),
    lunaMode,
  });
}

function renderResults(groups) {
  state.candidates.clear();
  resultLists.innerHTML = "";
  const compactMode = document.getElementById("compactMode").checked;
  const config = [
    ["secret", "隐藏房可能胜出的权重范围", "secret"],
    ["superSecret", groups.lunaMode ? "Luna 超隐死路排序" : "超隐死路排序", "super"],
    ["ultra", "红隐连接级别", "ultra"],
  ];
  let total = 0;
  for (const [id, title, className] of config) {
    const items = groups[id];
    total += items.length;
    const node = template.content.cloneNode(true);
    node.querySelector("h3").textContent = `${title} (${items.length})`;
    const list = node.querySelector("ol");
    if (!items.length) {
      const li = document.createElement("li");
      li.textContent = "没有候选点";
      list.appendChild(li);
    }
    items.forEach((item) => {
      const li = document.createElement("li");
      li.innerHTML = compactMode
        ? `${coordName(item.x, item.y)}`
        : `${coordName(item.x, item.y)} <span class="score">${item.text}<br>${item.detail}</span>`;
      list.appendChild(li);
      const key = keyOf(item.x, item.y);
      const old = state.candidates.get(key) || [];
      old.push({ id: className, mark: item.gridMark, depth: candidateDepth(className, item) });
      state.candidates.set(key, old);
    });
    resultLists.appendChild(node);
  }
  summary.textContent = total
    ? compactMode
      ? `已找到 ${total} 个候选位置。`
      : `已按游戏生成口径标出 ${total} 个指标：W=隐藏房仍可能胜出的权重范围，D/#=超隐死路距离/死路序号，R=红隐可连接房间数。`
    : "当前地图没有可用候选点。";
  renderGrid();
}

function candidateDepth(className, item) {
  if (className === "secret") {
    if (item.sortValue >= 1400) return 5;
    if (item.sortValue >= 1100) return 3;
    return 1;
  }
  if (className === "super") {
    if (item.sortValue >= 5) return 5;
    if (item.sortValue >= 3) return 4;
    if (item.sortValue >= 2) return 3;
    return 2;
  }
  if (className === "ultra") {
    if (item.sortValue >= 300) return 5;
    if (item.sortValue >= 200) return 3;
    return 2;
  }
  return 3;
}

function renderGrid() {
  grid.innerHTML = "";
  const groupSizes = sizeByGroup();
  const compactMode = document.getElementById("compactMode").checked;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const key = keyOf(x, y);
      const data = getCell(x, y);
      const el = document.createElement("button");
      el.className = "cell";
      el.dataset.x = x;
      el.dataset.y = y;
      el.title = coordName(x, y);
      if (state.selectedCells.has(key)) el.classList.add("grid-selected");

      if (data && data.type) {
        el.classList.add("room", data.type);
        if (data.groupId) {
          el.dataset.group = data.groupId;
          addFusionEdgeClasses(el, x, y, data);
        }
        if (!data.groupId || groupSizes.get(data.groupId) <= 1) {
          const label = document.createElement("span");
          label.className = "label";
          label.textContent = roomMeta(data.type).short;
          el.appendChild(label);
        }
      }

      const cand = state.candidates.get(key);
      if (cand) {
        el.classList.add("candidate");
        const stack = document.createElement("span");
        stack.className = "candidate-stack";
        for (const item of cand) {
          const tag = document.createElement("span");
          tag.className = `candidate-tag cand-${item.id} depth-${item.depth || 3}`;
          tag.textContent = compactMode ? compactMark(item.id) : item.mark;
          stack.appendChild(tag);
        }
        el.appendChild(stack);
      }

      if (data) {
        for (const wall of data.walls) {
          const mark = document.createElement("span");
          mark.className = `wall ${wall}`;
          mark.addEventListener("click", (event) => {
            event.stopPropagation();
            pushHistory();
            data.walls.delete(wall);
            markDirty();
            renderGrid();
          });
          el.appendChild(mark);
        }
      }

      el.addEventListener("click", onCellClick);
      el.addEventListener("pointerdown", onCellPointerDown);
      el.addEventListener("pointerup", onCellPointerUp);
      grid.appendChild(el);
    }
  }
  updateFusionSelectionInfo();
}

function compactMark(id) {
  if (id === "secret") return "隐";
  if (id === "super") return "超";
  if (id === "ultra") return "红";
  return "";
}

function sizeByGroup() {
  const sizes = new Map();
  for (const [key, cell] of state.cells) {
    if (!isRoom(cell) || !cell.groupId) continue;
    sizes.set(cell.groupId, (sizes.get(cell.groupId) || 0) + 1);
  }
  return sizes;
}

function updateFusionSelectionInfo() {
  const count = [...state.selectedCells].filter((key) => isRoom(state.cells.get(key))).length;
  fusionSelectionInfo.textContent = `已选 ${count} 个房间`;
}

function addFusionEdgeClasses(el, x, y, cell) {
  for (const dir of dirs) {
    const nx = x + dir.dx;
    const ny = y + dir.dy;
    const neighbor = getCell(nx, ny);
    if (isRoom(neighbor) && groupIdFor(nx, ny, neighbor) === groupIdFor(x, y, cell)) {
      el.classList.add(`joined-${dir.key}`);
    }
  }
}

function wallNearPointer(event, cellEl) {
  const directWall = [...event.target.classList || []].find((name) => ["top", "right", "bottom", "left"].includes(name));
  if (directWall) return directWall;
  const rect = cellEl.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const distances = [
    { wall: "top", value: y },
    { wall: "right", value: rect.width - x },
    { wall: "bottom", value: rect.height - y },
    { wall: "left", value: x },
  ].sort((a, b) => a.value - b.value);
  return distances[0].value <= Math.min(rect.width, rect.height) * 0.28 ? distances[0].wall : null;
}

function removeWallFromContext(event) {
  const cellEl = event.target.closest(".cell");
  if (!cellEl) return false;
  const x = Number(cellEl.dataset.x);
  const y = Number(cellEl.dataset.y);
  const cell = getCell(x, y);
  if (!cell) return false;
  const wall = wallNearPointer(event, cellEl);
  if (!wall || !cell.walls.has(wall)) return false;
  pushHistory();
  cell.walls.delete(wall);
  markDirty();
  renderGrid();
  return true;
}

function markDirty() {
  state.candidates.clear();
  summary.textContent = "地图已修改，点击“确认并分析”刷新生成指标。";
  resultLists.innerHTML = "";
}

function applyRoomToSelectedCells(type) {
  if (!state.selectedCells.size) return false;
  pushHistory();
  for (const key of state.selectedCells) {
    const [x, y] = parseKey(key);
    const cell = ensureCell(x, y);
    if (type === "start") {
      clearExistingStart();
    }
    cell.type = type;
    cell.groupId = type === null ? null : `g${state.nextGroupId++}`;
    if (type === null) {
      cell.walls.clear();
      state.fusionSelection.delete(key);
    }
  }
  state.selectedCells.clear();
  markDirty();
  renderGrid();
  return true;
}

function applyWallsToSelectedCells(walls) {
  if (!state.selectedCells.size) return false;
  const roomKeys = [...state.selectedCells].filter((key) => isRoom(state.cells.get(key)));
  if (!roomKeys.length) {
    summary.textContent = "堵墙只能添加到已有房间上。";
    return true;
  }
  pushHistory();
  for (const key of roomKeys) {
    const [x, y] = parseKey(key);
    const cell = ensureCell(x, y);
    for (const wall of walls) {
      if (cell.walls.has(wall)) cell.walls.delete(wall);
      else cell.walls.add(wall);
    }
  }
  state.selectedCells.clear();
  markDirty();
  renderGrid();
  return true;
}

function toggleSelectedCell(x, y) {
  const key = keyOf(x, y);
  if (state.selectedCells.has(key)) state.selectedCells.delete(key);
  else state.selectedCells.add(key);
  updateFusionSelectionInfo();
}

function cloneCell(cell) {
  return {
    type: cell?.type || null,
    groupId: cell?.groupId || null,
    walls: new Set(cell?.walls || []),
  };
}

function canMoveSelection(dx, dy) {
  if (!state.selectedCells.size || (dx === 0 && dy === 0)) return false;
  for (const key of state.selectedCells) {
    const [x, y] = parseKey(key);
    const tx = x + dx;
    const ty = y + dy;
    if (!inBounds(tx, ty)) return false;
    const targetKey = keyOf(tx, ty);
    const targetCell = getCell(tx, ty);
    if (isRoom(targetCell) && !state.selectedCells.has(targetKey)) return false;
  }
  return true;
}

function moveSelection(dx, dy) {
  if (!canMoveSelection(dx, dy)) return false;
  pushHistory();
  const moving = new Map();
  for (const key of state.selectedCells) {
    const [x, y] = parseKey(key);
    moving.set(keyOf(x + dx, y + dy), cloneCell(getCell(x, y)));
  }
  for (const key of state.selectedCells) {
    state.cells.delete(key);
  }
  for (const [key, cell] of moving) {
    state.cells.set(key, cell);
  }
  state.selectedCells = new Set(moving.keys());
  state.fusionSelection.clear();
  markDirty();
  return true;
}

function validateMerge(keys) {
  if (keys.length < 2) return "至少选择两个已有房间格子才能合并。";
  const cells = keys.map((key) => state.cells.get(key));
  if (cells.some((cell) => !isRoom(cell))) return "选择中包含空格，无法合并。";
  const type = cells[0].type;
  if (cells.some((cell) => cell.type !== type)) return "只能合并同一种房间。";

  const selected = new Set(keys);
  const queue = [keys[0]];
  const seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = parseKey(queue[i]);
    for (const dir of dirs) {
      const nextKey = keyOf(x + dir.dx, y + dir.dy);
      if (!selected.has(nextKey) || seen.has(nextKey)) continue;
      seen.add(nextKey);
      queue.push(nextKey);
    }
  }
  if (seen.size !== selected.size) return "选中的房间格子必须四向连通。";
  if (!isAllowedMergeShape(keys)) return "只允许 1x2、2x1、2x2 或 3 格 L 形房间融合。";

  if (type === "start") {
    const outsideStart = [...state.cells].some(([key, cell]) => !selected.has(key) && cell.type === "start");
    if (outsideStart) return "出生房只能有一个，不能和其它出生房并存。";
  }

  return "";
}

function isAllowedMergeShape(keys) {
  const points = keys.map(parseKey);
  const minX = Math.min(...points.map(([x]) => x));
  const minY = Math.min(...points.map(([, y]) => y));
  const normalized = points
    .map(([x, y]) => `${x - minX},${y - minY}`)
    .sort()
    .join(";");

  const allowedShapes = new Set([
    "0,0;1,0",
    "0,0;0,1",
    "0,0;0,1;1,0",
    "0,0;0,1;1,1",
    "0,0;1,0;1,1",
    "0,1;1,0;1,1",
    "0,0;0,1;1,0;1,1",
  ]);

  return allowedShapes.has(normalized);
}

function onCellPointerDown(event) {
  const x = Number(event.currentTarget.dataset.x);
  const y = Number(event.currentTarget.dataset.y);
  const key = keyOf(x, y);
  if (!state.selectedCells.has(key)) return;
  state.drag = { x, y };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function onCellPointerUp(event) {
  if (!state.drag) return;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".cell");
  if (!target) {
    state.drag = null;
    return;
  }
  const x = Number(target.dataset.x);
  const y = Number(target.dataset.y);
  const dx = x - state.drag.x;
  const dy = y - state.drag.y;
  state.drag = null;
  if (dx === 0 && dy === 0) return;
  state.suppressClick = true;
  if (!moveSelection(dx, dy)) {
    summary.textContent = "移动取消：目标区域有房间重合或超出网格。";
  }
  renderGrid();
}

function toggleFusionCell(x, y) {
  toggleSelectedCell(x, y);
  updateFusionSelectionInfo();
}

function onCellClick(event) {
  if (state.suppressClick) {
    state.suppressClick = false;
    return;
  }
  const x = Number(event.currentTarget.dataset.x);
  const y = Number(event.currentTarget.dataset.y);
  const cell = ensureCell(x, y);

  if (state.selectionMode) {
    toggleSelectedCell(x, y);
    renderGrid();
    return;
  }

  if (!state.selectedWalls.size && state.selectedRoom === null && !state.eraseMode) {
    toggleSelectedCell(x, y);
    renderGrid();
    return;
  }

  if (state.selectedWalls.size) {
    if (!isRoom(cell)) {
      summary.textContent = "堵墙只能添加到已有房间上。";
      return;
    }
    pushHistory();
    markDirty();
    for (const wall of state.selectedWalls) {
      if (cell.walls.has(wall)) cell.walls.delete(wall);
      else cell.walls.add(wall);
    }
    state.selectedWalls.clear();
  } else if (isRoom(cell) && state.selectedRoom !== null && !state.eraseMode) {
    toggleFusionCell(x, y);
  } else {
    pushHistory();
    markDirty();
    const usedRoomType = state.selectedRoom;
    if (state.selectedRoom === "start") {
      clearExistingStart();
    }
    cell.type = state.eraseMode ? null : state.selectedRoom;
    cell.groupId = state.eraseMode || state.selectedRoom === null ? null : `g${state.nextGroupId++}`;
    if (state.eraseMode || state.selectedRoom === null) {
      cell.walls.clear();
      state.fusionSelection.delete(keyOf(x, y));
    }
    if (!state.eraseMode && usedRoomType !== null) {
      state.selectedRoom = null;
    }
  }
  renderGrid();
  syncTools();
}

function mergeSelectedRooms() {
  const keys = [...state.selectedCells];
  const reason = validateMerge(keys);
  if (reason) {
    summary.textContent = `合并失败：${reason}`;
    return;
  }
  pushHistory();
  const primary = state.cells.get(keys[0]);
  const groupId = primary.groupId || `g${state.nextGroupId++}`;
  for (const key of keys) {
    const cell = state.cells.get(key);
    cell.type = primary.type;
    cell.groupId = groupId;
  }
  state.selectedCells.clear();
  markDirty();
  renderGrid();
}

function splitSelectedRooms() {
  const keys = [...state.selectedCells].filter((key) => isRoom(state.cells.get(key)));
  if (!keys.length) return;
  pushHistory();
  for (const key of keys) {
    const cell = state.cells.get(key);
    cell.groupId = `g${state.nextGroupId++}`;
  }
  state.selectedCells.clear();
  markDirty();
  renderGrid();
}

function selectRoom(type) {
  if (applyRoomToSelectedCells(type)) {
    state.selectedRoom = null;
    state.eraseMode = false;
    state.selectedWalls.clear();
    state.selectionMode = false;
    syncTools();
    return;
  }
  if (state.selectedRoom === type && !state.eraseMode) {
    state.selectedRoom = null;
    state.selectedWalls.clear();
    state.selectionMode = false;
    syncTools();
    return;
  }
  state.selectedRoom = type;
  state.eraseMode = false;
  state.selectedWalls.clear();
  state.selectionMode = false;
  syncTools();
}

function toggleWall(wall) {
  if (applyWallsToSelectedCells([wall])) {
    state.selectedWalls.clear();
    state.selectionMode = false;
    syncTools();
    return;
  }
  state.selectionMode = false;
  state.eraseMode = false;
  if (state.selectedWalls.has(wall)) state.selectedWalls.delete(wall);
  else state.selectedWalls.add(wall);
  syncTools();
}

function syncTools() {
  document.querySelectorAll(".room-tool").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.room === state.selectedRoom && !state.selectedWalls.size && !state.eraseMode);
  });
  document.getElementById("eraseBtn").classList.toggle("active", state.eraseMode);
  document.querySelectorAll(".wall-tool").forEach((btn) => {
    btn.classList.toggle("active", state.selectedWalls.has(btn.dataset.wall));
  });
}

function setupLegend() {
  legend.innerHTML = roomTypes
    .map((room) => `<span><b class="chip ${room.id}"></b>${room.name}</span>`)
    .join("");
}

function setupTools() {
  setupLegend();
  for (const room of roomTypes) {
    const button = document.createElement("button");
    button.className = "room-tool";
    button.dataset.room = room.id;
    button.innerHTML = `<b class="chip ${room.id}"></b>${room.name}`;
    button.addEventListener("click", () => selectRoom(room.id));
    roomTools.appendChild(button);
  }
  document.getElementById("eraseBtn").addEventListener("click", () => {
    state.selectedRoom = null;
    state.eraseMode = !state.eraseMode;
    state.selectedWalls.clear();
    state.selectionMode = false;
    syncTools();
  });
  grid.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (removeWallFromContext(event)) return;
    state.selectedCells.clear();
    state.fusionSelection.clear();
    updateFusionSelectionInfo();
    renderGrid();
  });
  document.querySelectorAll(".wall-tool").forEach((button) => {
    button.addEventListener("click", () => toggleWall(button.dataset.wall));
  });
  document.getElementById("clearWallSelectionBtn").addEventListener("click", () => {
    state.selectedWalls.clear();
    syncTools();
  });
  document.getElementById("mergeRoomsBtn").addEventListener("click", mergeSelectedRooms);
  document.getElementById("splitRoomsBtn").addEventListener("click", splitSelectedRooms);
  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("clearFusionSelectionBtn").addEventListener("click", () => {
    state.selectedCells.clear();
    state.fusionSelection.clear();
    updateFusionSelectionInfo();
    renderGrid();
  });
  document.getElementById("analyzeBtn").addEventListener("click", analyze);
  document.getElementById("clearHintsBtn").addEventListener("click", () => {
    state.candidates.clear();
    resultLists.innerHTML = "";
    summary.textContent = "结果已清除。";
    renderGrid();
  });
  document.getElementById("compactMode").addEventListener("change", () => {
    if (resultLists.children.length) analyze();
    else renderGrid();
  });
  document.getElementById("lunaMode").addEventListener("change", () => {
    if (resultLists.children.length) analyze();
  });
  document.getElementById("resetBtn").addEventListener("click", () => {
    pushHistory();
    state.cells.clear();
    state.candidates.clear();
    state.selectedWalls.clear();
    state.fusionSelection.clear();
    state.selectedCells.clear();
    state.selectionMode = false;
    state.eraseMode = false;
    resultLists.innerHTML = "";
    summary.textContent = "地图已重置。";
    syncTools();
    renderGrid();
  });
  syncTools();
}

setupTools();
renderGrid();
