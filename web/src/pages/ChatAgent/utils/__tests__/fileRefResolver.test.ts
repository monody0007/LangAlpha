import { describe, it, expect } from 'vitest';
import {
  collectRecentWritePaths,
  downloadTarget,
  linkCandidates,
  resolveExact,
  type TurnMessage,
} from '../fileRefResolver';

describe('linkCandidates', () => {
  it('reads a link against the linking file first, then from the root', () => {
    expect(linkCandidates('charts/fig.png', 'results/report.md')).toEqual(['results/charts/fig.png', 'charts/fig.png']);
  });

  it('offers one candidate when both readings agree', () => {
    expect(linkCandidates('x.csv', 'report.md')).toEqual(['x.csv']);
  });

  it('lets a climbing link climb, against the directory it was written in', () => {
    // `../data/x.csv` inside `results/report.md` is `data/x.csv`. Normalizing
    // the `..` away first left `data/x.csv` looking like a bare root-relative
    // name, so the join produced `results/data/x.csv` and the file the link
    // named was in neither candidate.
    expect(linkCandidates('../data/x.csv', 'results/report.md')).toEqual(['data/x.csv', '../data/x.csv']);
  });

  it('does not rebase a link that names its own workspace', () => {
    // The reader's open file says nothing about where another workspace keeps
    // its files; joining produced `results/__wsref__/…`, which no workspace holds.
    expect(linkCandidates('__wsref__/ws-7/data/x.csv', 'results/report.md')).toEqual(['data/x.csv']);
  });

  it('does not rebase an absolute link', () => {
    expect(linkCandidates('/home/workspace/data/x.csv', 'results/report.md')).toEqual(['data/x.csv']);
  });
});

describe('resolveExact', () => {
  const files = ['results/report.md', 'work/task/results/summary.md', 'data/x.csv'];

  it('opens an exact path from the list or this thread’s writes', () => {
    expect(resolveExact(['results/report.md'], files, [])).toBe('results/report.md');
    expect(resolveExact(['results/new.md'], files, ['results/new.md'])).toBe('results/new.md');
  });

  it('leaves a path that is only a suffix of a listed file to the server lookup', () => {
    expect(resolveExact(['results/summary.md'], files, [])).toBeNull();
  });
});

describe('collectRecentWritePaths', () => {
  const call = (toolName: string, path: string, order: number, isFailed = false) => ({
    toolName,
    toolCall: { args: { file_path: path } },
    isFailed,
    isComplete: true,
    toolCallResult: { content: 'ok' },
    order,
  });

  it('lists Write and Edit paths newest first, once each', () => {
    const messages: TurnMessage[] = [
      { toolCallProcesses: { a: call('Write', '/home/workspace/results/a.md', 1), b: call('Read', 'results/r.md', 2) } },
      { role: 'user' },
      {
        toolCallProcesses: {
          c: call('Edit', 'results/a.md', 1),
          d: call('Write', 'results/b.md', 2),
          e: call('Write', 'results/failed.md', 3, true),
        },
      },
    ];
    expect(collectRecentWritePaths(messages)).toEqual(['results/b.md', 'results/a.md']);
  });

  it('names a write under the workspace folder by its path inside it', () => {
    const messages: TurnMessage[] = [
      { toolCallProcesses: { a: call('Write', '/home/workspace/Research/results/a.md', 1) } },
      { toolCallProcesses: { b: call('Edit', '/home/workspace/research-ab12/results/b.md', 1) } },
    ];
    expect(collectRecentWritePaths(messages, 'Research', ['research-ab12'])).toEqual(['results/b.md', 'results/a.md']);
  });
});

/**
 * Save and open are the same card's two affordances, so they have to agree
 * about which file the card names. Open went through the lookup and save did
 * not, so a report the reader had just opened failed to download.
 */
describe('downloadTarget', () => {
  it('saves the path the lookup resolved, not the one the reply wrote', async () => {
    const resolve = async () => ({ status: 'resolved', path: 'work/q3/report.md' });
    expect(await downloadTarget('report.md', resolve)).toEqual({ path: 'work/q3/report.md', placed: true });
  });

  it('leaves the reference unplaced when the lookup found namesakes and could not pick', async () => {
    // Nothing occupies the reference, so the caller sends the click to the
    // panel that lists the matches rather than fetching a 404 in silence.
    expect(await downloadTarget('report.md', async () => ({ status: 'ambiguous' })))
      .toEqual({ path: 'report.md', placed: false });
    expect(await downloadTarget('report.md', async () => ({ status: 'missing' })))
      .toEqual({ path: 'report.md', placed: false });
  });

  it('saves the reference when nothing contradicts it', async () => {
    // No lookup, one that threw, one that has not looked yet, and a resolve
    // that named no path: none of these is evidence against the reference.
    expect(await downloadTarget('results/report.md', null)).toEqual({ path: 'results/report.md', placed: true });
    const throws = async () => { throw new Error('offline'); };
    expect(await downloadTarget('results/report.md', throws)).toEqual({ path: 'results/report.md', placed: true });
    expect(await downloadTarget('report.md', async () => ({ status: 'unavailable' })))
      .toEqual({ path: 'report.md', placed: true });
    expect(await downloadTarget('report.md', async () => ({ status: 'resolved', path: null })))
      .toEqual({ path: 'report.md', placed: true });
  });

  it('passes this thread’s writes as the tiebreak between namesakes', async () => {
    const seen: string[][] = [];
    await downloadTarget('report.md', async (candidates, recentWrites) => {
      seen.push(candidates, recentWrites);
      return { status: 'resolved', path: 'a/report.md' };
    }, ['a/report.md', 'b/report.md']);
    expect(seen).toEqual([['report.md'], ['a/report.md', 'b/report.md']]);
  });
});
