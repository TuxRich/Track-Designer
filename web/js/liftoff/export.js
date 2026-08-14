// Entry point: a designer track in, a Liftoff-ready zip out.
//
// The archive mirrors the Liftoff save folder, so it extracts straight over
//   %USERPROFILE%\AppData\LocalLow\LuGus Studios\Liftoff\
// with nothing to rename:
//
//   Tracks/<track-guid>/<track-guid>_0001.track
//   Races/<race-guid>/<race-guid>_0001.race
//
// The two files are joined only by the GUID the .race names in its
// <dependencies>; there is no index or manifest to update.

import { convert, POLE_TRIGGER_MARGIN } from './convert.js';
import { makeZip } from './zip.js';

export { POLE_TRIGGER_MARGIN };

/** Same sanitising the screenshot button uses, so filenames look consistent. */
function safeName(name) {
  return (name || 'track').trim().replace(/[^\w-]+/g, '_');
}

/**
 * Convert and package in one step.
 *
 * @param {object} src  {id, name, data:{arena, gates}}
 * @param {object} defs {typeId: gateDefinition} from GET /api/gates
 * @param {object} opts {scale, poleTrigger, environment}
 * @returns {{blob: Blob, filename: string, result: object}}
 */
export function exportLiftoffZip(src, defs, opts = {}) {
  const result = convert(src, { ...opts, defs });
  const blob = makeZip([
    {
      name: `Tracks/${result.trackGuid}/${result.trackGuid}_0001.track`,
      text: result.track,
    },
    {
      name: `Races/${result.raceGuid}/${result.raceGuid}_0001.race`,
      text: result.race,
    },
  ]);
  const scale = opts.scale ?? 2;
  return {
    blob,
    filename: `${safeName(src.name)}_liftoff_x${scale}.zip`,
    result,
  };
}

/** Convert, package and hand it to the browser as a download. */
export function downloadLiftoffZip(src, defs, opts = {}) {
  const { blob, filename, result } = exportLiftoffZip(src, defs, opts);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { filename, result };
}
