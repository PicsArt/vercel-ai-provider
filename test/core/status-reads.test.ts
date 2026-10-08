import { describe, expect, it } from 'vitest';
import { recordStatusReads } from '../../src/core/status-reads';

const READ = 'https://api.test/workflows/some-flow/job-1/result';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('recordStatusReads', () => {
  it('records the envelope of a successful result read by generation id', async () => {
    const reads = recordStatusReads(async () => json({ response: { status: 'FAILED', result: { reason: 'blocked by policy' } } }));
    const response = await reads.fetch(READ);
    expect(await response.json()).toEqual({ response: { status: 'FAILED', result: { reason: 'blocked by policy' } } });
    expect(reads.log.last('job-1')).toEqual({ http: 200, envelope: { status: 'FAILED', hasResult: true, message: 'blocked by policy' } });
  });

  it('prefers result.message, then result.error, then result.reason', async () => {
    const reads = recordStatusReads(async () => json({ response: { status: 'FAILED', result: { message: 'first', error: 'second', reason: 'third' } } }));
    await reads.fetch(READ);
    expect(reads.log.last('job-1')?.envelope?.message).toBe('first');
  });

  it('records a read with no result', async () => {
    const reads = recordStatusReads(async () => json({ response: { status: 'IN_PROGRESS', result: null } }));
    await reads.fetch(READ);
    expect(reads.log.last('job-1')).toEqual({ http: 200, envelope: { status: 'IN_PROGRESS', hasResult: false } });
  });

  it('records only the HTTP status of a failed or unrecognized read', async () => {
    const bodies = [json({ reason: 'not_found' }, 404), new Response('<html>oops</html>'), json({ response: { status: 'QUEUED' } }), json({ items: [] })];
    const reads = recordStatusReads(async () => bodies.shift()!);
    const outcomes: unknown[] = [];
    for (let read = 0; read < 4; read += 1) {
      await reads.fetch(READ);
      outcomes.push(reads.log.last('job-1'));
    }
    expect(outcomes).toEqual([{ http: 404 }, { http: 200 }, { http: 200 }, { http: 200 }]);
  });

  it('records no envelope for a failed response, whatever its body', async () => {
    const reads = recordStatusReads(async () => json({ response: { status: 'FAILED', result: { message: 'blocked' } } }, 500));
    await reads.fetch(READ);
    expect(reads.log.last('job-1')).toEqual({ http: 500 });
  });

  it('treats a falsy result as no result', async () => {
    for (const result of ['', 0, false]) {
      const reads = recordStatusReads(async () => json({ response: { status: 'COMPLETED', result } }));
      await reads.fetch(READ);
      expect(reads.log.last('job-1')).toEqual({ http: 200, envelope: { status: 'COMPLETED', hasResult: false } });
    }
  });

  it('keys a read by the generation id as written, not as encoded', async () => {
    const reads = recordStatusReads(async () => json({ response: { status: 'IN_PROGRESS' } }));
    await reads.fetch('https://api.test/workflows/some-flow/café:1.2/result');
    expect(reads.log.last('café:1.2')).toEqual({ http: 200, envelope: { status: 'IN_PROGRESS', hasResult: false } });
  });

  it('drops a stale outcome as soon as a new read of the same id starts', async () => {
    let release: (response: Response) => void = () => undefined;
    let call = 0;
    const reads = recordStatusReads(async () => {
      call += 1;
      if (call === 1) return json({ response: { status: 'FAILED', result: null } });
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    await reads.fetch(READ);
    expect(reads.log.last('job-1')?.envelope?.status).toBe('FAILED');
    const inFlight = reads.fetch(READ);
    expect(reads.log.last('job-1')).toBeUndefined();
    release(json({ response: { status: 'IN_PROGRESS' } }));
    await inFlight;
    expect(reads.log.last('job-1')?.envelope?.status).toBe('IN_PROGRESS');
  });

  it('keeps the response body readable', async () => {
    const reads = recordStatusReads(async () => new Response('not json'));
    expect(await (await reads.fetch(READ)).text()).toBe('not json');
  });

  it('resets the record before each read', async () => {
    let call = 0;
    const reads = recordStatusReads(async () => {
      call += 1;
      if (call === 1) return json({ response: { status: 'IN_PROGRESS' } });
      throw new TypeError('fetch failed');
    });
    await reads.fetch(READ);
    await expect(reads.fetch(READ)).rejects.toThrow('fetch failed');
    expect(reads.log.last('job-1')).toEqual({ network: true });
  });

  it('leaves other requests alone', async () => {
    const urls: string[] = [];
    const reads = recordStatusReads(async (url) => {
      urls.push(url);
      return json({ response: { id: 'job-1' } });
    });
    await reads.fetch('https://api.test/workflows/some-flow/submit', { method: 'POST' });
    expect(urls).toEqual(['https://api.test/workflows/some-flow/submit']);
    expect(reads.log.last('job-1')).toBeUndefined();
  });

  it('forgets a record', async () => {
    const reads = recordStatusReads(async () => json({ response: { status: 'IN_PROGRESS' } }));
    await reads.fetch(READ);
    reads.log.forget('job-1');
    expect(reads.log.last('job-1')).toBeUndefined();
  });
});
