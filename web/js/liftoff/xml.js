// Writers for Liftoff .track and .race XML.
//
// Port of tools/liftoff_xml.py from the LO-MicroTrackCreator project. Nothing
// here knows about the designer -- this layer only speaks Liftoff. Kept as a
// near-line-for-line translation so the two can be diffed by eye when either
// changes; the parity harness asserts they agree byte for byte.
//
// Conventions taken from the shipped sample tracks:
//   * positions are metres, world space, Y up
//   * rotations are degrees, Euler XYZ
//   * props are bottom-pivot (a 5 m cylinder at y=0 occupies 0..5)
//   * the TheDrawingBoard floor surface is y = 0

export const GAME_VERSION = '1.7.4';

/** Hands out instanceIDs. The .race refers to checkpoints by these. */
export class Instances {
  constructor(start = 1) { this._next = start; }
  take() { return this._next++; }
}

/**
 * Canonical number text. Must match liftoff_xml.num() in Python exactly:
 * plain interpolation would render 2.0 as "2" here and "2.0" there. Fixing to
 * 4 dp and stripping trailing zeros gives one spelling both produce, and the
 * rounding absorbs last-ulp differences between the two atan2 implementations.
 */
export function num(v) {
  let s = Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return (s === '' || s === '-0') ? '0' : s;
}

/** XML text escaping. Matches Python's xml.sax.saxutils.escape: & < > only. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function vec(tag, v) {
  return `<${tag}><x>${num(v[0])}</x><y>${num(v[1])}</y><z>${num(v[2])}</z></${tag}>`;
}

/** A piece of geometry. Use TrackBlueprintFlexibleFlag for scalable checkpoints. */
export function flag(itemId, inst, pos, rot = [0, 0, 0], scale = null,
                     subtype = 'TrackBlueprintFlag', purpose = null) {
  const out = [
    `    <TrackBlueprint xsi:type="${subtype}">`,
    `      <itemID>${itemId}</itemID>`,
    `      <instanceID>${inst}</instanceID>`,
    `      ${vec('position', pos)}`,
    `      ${vec('rotation', rot)}`,
  ];
  if (purpose) out.push(`      <purpose>${purpose}</purpose>`);
  if (scale !== null) out.push(`      ${vec('scale', scale)}`);
  out.push('    </TrackBlueprint>');
  return out.join('\n');
}

/** A scalable checkpoint. This is what makes sub-metre gates expressible. */
export function checkpoint(inst, pos, rot = [0, 0, 0], scale = [1, 1, 0.2]) {
  return flag('CheckpointBoxFlexible01', inst, pos, rot, scale,
              'TrackBlueprintFlexibleFlag');
}

export function spawnpoint(inst, pos, rot = [0, 0, 0], name = 'Start') {
  return [
    '    <TrackBlueprint xsi:type="TrackBlueprintSpawnpoint">',
    '      <itemID>SpawnPointSingle02</itemID>',
    `      <instanceID>${inst}</instanceID>`,
    `      ${vec('position', pos)}`,
    `      ${vec('rotation', rot)}`,
    '      <spawnpoint xsi:type="NamedDroneSpawnpoint">',
    `        <name>${esc(name)}</name>`,
    '      </spawnpoint>',
    '    </TrackBlueprint>',
  ].join('\n');
}

export function trackXml(guid, name, blueprints, environment = 'TheDrawingBoard',
                        hideDefaultSpawn = true, description = '') {
  const body = blueprints.join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<Track xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <gameVersion>${GAME_VERSION}</gameVersion>
  <dependencies />
  <localID>
    <str>${guid}</str>
    <version>1</version>
    <type>TRACK</type>
  </localID>
  <name>${esc(name)}</name>
  <description>${esc(description)}</description>
  <environment>${environment}</environment>
  <blueprints>
${body}
  </blueprints>
  <hideDefaultSpawnpoint>${hideDefaultSpawn ? 'true' : 'false'}</hideDefaultSpawnpoint>
</Track>
`;
}

/**
 * checkpointIds in flight order; first becomes Start, last becomes Finish.
 *
 * nextPassageIDs is a list in the schema, so branching routes are possible;
 * this writer only emits linear chains.
 */
export function raceXml(guid, name, trackGuid, checkpointIds, spawnId, laps = 1,
                        directionality = 'LeftToRight') {
  const pids = checkpointIds.map(
    (_, i) => `${guid.slice(0, 24)}${String(i).padStart(12, '0')}`);

  const passages = checkpointIds.map((cp, i) => {
    const kind = i === 0 ? 'Start'
      : i === checkpointIds.length - 1 ? 'Finish' : 'Pass';
    const nxt = i + 1 < checkpointIds.length ? `<string>${pids[i + 1]}</string>` : '';
    return `    <RaceCheckpointPassage>
      <uniqueId>${pids[i]}</uniqueId>
      <checkPointID>${cp}</checkPointID>
      <checkPointSubID />
      <passageType>${kind}</passageType>
      <directionality>${directionality}</directionality>
      <nextPassageIDs>${nxt}</nextPassageIDs>
    </RaceCheckpointPassage>`;
  });

  return `<?xml version="1.0" encoding="utf-8"?>
<Race xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <gameVersion>${GAME_VERSION}</gameVersion>
  <localID>
    <str>${guid}</str>
    <version>1</version>
    <type>RACE</type>
  </localID>
  <name>${esc(name)}</name>
  <description />
  <dependencies>
    <dependency>
      <str>${trackGuid}</str>
      <version>1</version>
      <type>TRACK</type>
    </dependency>
  </dependencies>
  <checkPointPassages>
${passages.join('\n')}
  </checkPointPassages>
  <requiredLaps>${laps}</requiredLaps>
  <spawnPointID>${spawnId}</spawnPointID>
  <validity>Valid</validity>
</Race>
`;
}
