import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  htmlToText,
  MAX_CONTENT_CHARS,
  OMITTED_EMBED_MARKER,
  toHomework,
  toTests,
  TRUNCATION_MARKER,
} from '../src/assignments.js';
import {
  Appointment,
  AppointmentSchema,
  AppointmentsSchema,
  MAX_APPOINTMENTS,
} from '../src/magister-api.js';

/** All text below is synthetic. */
function appt(overrides: Partial<Appointment> & { Id?: unknown } = {}): Appointment {
  return AppointmentSchema.parse({
    Start: '2026-11-16T08:30:00.0000000+01:00',
    Einde: '2026-11-16T09:20:00.0000000+01:00',
    Omschrijving: 'wis - 1a',
    Vakken: [{ Naam: 'Wiskunde' }],
    Docenten: [{ Naam: 'T. Synthetic' }],
    Lokalen: [{ Naam: 'B1.01' }],
    Status: 1,
    Inhoud: '<p>Opgave 1 t/m 4</p>',
    Id: 11,
    InfoType: 1,
    Afgerond: false,
    ...overrides,
  });
}

describe('assignment classification', () => {
  it('maps InfoType 1 to homework with all fields', () => {
    assert.deepEqual(toHomework([appt()]), [
      {
        start: '2026-11-16T08:30:00.0000000+01:00',
        date: '2026-11-16',
        startTime: '08:30',
        endTime: '09:20',
        subject: 'Wiskunde',
        kind: 'Huiswerk',
        content: 'Opgave 1 t/m 4',
        completed: false,
        cancelled: false,
      },
    ]);
    assert.deepEqual(toTests([appt()]), []);
  });

  it('maps InfoType 2 to 5 to tests with their labels', () => {
    const items = [2, 3, 4, 5].map((InfoType) => appt({ InfoType }));
    assert.deepEqual(
      toTests(items).map((item) => item.kind),
      ['Proefwerk', 'Tentamen', 'Schriftelijke overhoring', 'Mondelinge overhoring']
    );
    assert.deepEqual(toHomework(items), []);
  });

  it('excludes other, unknown, missing and null InfoTypes', () => {
    const items = [0, 6, 7, 99, null, undefined].map((InfoType) => appt({ InfoType }));
    assert.deepEqual(toHomework(items), []);
    assert.deepEqual(toTests(items), []);
  });

  it('does not expose the appointment id or any person data', () => {
    const [item] = toHomework([appt({ Id: 987654 })]);
    assert.equal(JSON.stringify(item).includes('987654'), false);
    assert.equal(JSON.stringify(item).includes('T. Synthetic'), false);
    assert.equal(JSON.stringify(item).includes('B1.01'), false);
  });

  it('keeps an item with empty or null content', () => {
    assert.equal(toHomework([appt({ Inhoud: '' })])[0].content, '');
    assert.equal(toHomework([appt({ Inhoud: null })])[0].content, '');
    assert.equal(toHomework([appt({ Inhoud: undefined })])[0].content, '');
  });

  it('prefers the subject name, then the description, then Unknown', () => {
    assert.equal(toHomework([appt()])[0].subject, 'Wiskunde');
    assert.equal(
      toHomework([appt({ Vakken: [{ Naam: ' \u200f ' }, { Naam: 'Engels' }] })])[0].subject,
      'Engels'
    );
    assert.equal(toHomework([appt({ Vakken: [{ Naam: ' \n\t ' }] })])[0].subject, 'wis - 1a');
    assert.equal(
      toHomework([appt({ Vakken: [{ Naam: '  ' }], Omschrijving: '\u202e\n ' })])[0].subject,
      'Unknown'
    );
    assert.equal(toHomework([appt({ Vakken: [] })])[0].subject, 'wis - 1a');
    assert.equal(toHomework([appt({ Vakken: [{ Naam: null }] })])[0].subject, 'wis - 1a');
    assert.equal(toHomework([appt({ Vakken: null, Omschrijving: null })])[0].subject, 'Unknown');
    assert.equal(toHomework([appt({ Vakken: null, Omschrijving: '' })])[0].subject, 'Unknown');
  });

  it('normalizes a subject to one readable line without interpreting it', () => {
    const subject = (fields: Partial<Appointment>) => toHomework([appt(fields)])[0].subject;
    assert.equal(subject({ Vakken: [{ Naam: ' Wis\nkunde\u202e\u0007\t B ' }] }), 'Wis kunde B');
    assert.equal(subject({ Vakken: null, Omschrijving: 'wis\r\n- 1a\u2066' }), 'wis - 1a');
    assert.equal(subject({ Vakken: [{ Naam: '<b>Wis</b> &amp;' }] }), '<b>Wis</b> &amp;');
  });

  it('reports completed as true, false or null when unknown', () => {
    assert.equal(toHomework([appt({ Afgerond: true })])[0].completed, true);
    assert.equal(toHomework([appt({ Afgerond: false })])[0].completed, false);
    assert.equal(toHomework([appt({ Afgerond: undefined })])[0].completed, null);
    assert.equal(toHomework([appt({ Afgerond: null })])[0].completed, null);
  });

  it('marks cancelled items from Status 5, Uitval and Vervallen', () => {
    assert.equal(toTests([appt({ InfoType: 2 })])[0].cancelled, false);
    assert.equal(toTests([appt({ InfoType: 2, Status: 5 })])[0].cancelled, true);
    assert.equal(toTests([appt({ InfoType: 2, Uitval: true })])[0].cancelled, true);
    assert.equal(toTests([appt({ InfoType: 2, Vervallen: true })])[0].cancelled, true);
  });

  it('sorts by the actual start instant and keeps equal starts stable', () => {
    const items = [
      appt({ Start: '2026-11-17T08:00:00Z', Einde: '2026-11-17T09:00:00Z', Inhoud: 'c' }),
      // 08:30+01:00 is 07:30Z: earlier than 08:00Z although it sorts later as text.
      appt({ Start: '2026-11-17T08:30:00+01:00', Einde: '2026-11-17T09:00:00Z', Inhoud: 'a' }),
      appt({ Start: '2026-11-17T07:30:00Z', Einde: '2026-11-17T09:00:00Z', Inhoud: 'b' }),
      appt({ Start: '2026-11-16T10:00:00Z', Einde: '2026-11-16T11:00:00Z', Inhoud: 'first' }),
    ];
    assert.deepEqual(
      toHomework(items).map((item) => item.content),
      ['first', 'a', 'b', 'c']
    );
  });

  it('dates and times items in Amsterdam', () => {
    const [item] = toHomework([
      appt({ Start: '2026-11-16T23:30:00Z', Einde: '2026-11-17T00:15:00Z' }),
    ]);
    assert.deepEqual([item.date, item.startTime, item.endTime], ['2026-11-17', '00:30', '01:15']);
  });
});

describe('appointment metadata at the API boundary', () => {
  for (const [field, value] of [
    ['InfoType', '1'],
    ['InfoType', 1.5],
    ['InfoType', -1],
    ['Afgerond', 'true'],
    ['Afgerond', 1],
  ] as const) {
    it(`rejects ${field}: ${JSON.stringify(value)}`, () => {
      assert.equal(
        AppointmentSchema.safeParse({
          Start: '2026-11-16T08:30:00Z',
          Einde: '2026-11-16T09:20:00Z',
          [field]: value,
        }).success,
        false
      );
    });
  }

  it('ignores the unused Id, whatever its value', () => {
    for (const Id of [0, -1, 1.5, '11', Number.MAX_SAFE_INTEGER + 2, null]) {
      const parsed = AppointmentSchema.parse({
        Start: '2026-11-16T08:30:00Z',
        Einde: '2026-11-16T09:20:00Z',
        Id,
        InfoType: 2,
        Afgerond: true,
      });
      assert.equal('Id' in parsed, false);
      assert.equal(parsed.InfoType, 2);
      assert.equal(parsed.Afgerond, true);
    }
    assert.equal(
      AppointmentsSchema.parse({
        Items: [{ Start: '2026-11-16T08:30:00Z', Einde: '2026-11-16T09:20:00Z', Id: 0 }],
        TotalCount: 1,
      }).length,
      1
    );
  });

  it('still accepts appointments without the new metadata', () => {
    const parsed = AppointmentSchema.parse({
      Start: '2026-11-16T08:30:00Z',
      Einde: '2026-11-16T09:20:00Z',
    });
    assert.equal(parsed.InfoType, undefined);
    assert.equal(parsed.Afgerond, undefined);
  });

  const item = { Start: '2026-11-16T08:30:00Z', Einde: '2026-11-16T09:20:00Z' };

  it('accepts an envelope whose TotalCount matches or is absent', () => {
    assert.equal(AppointmentsSchema.parse({ Items: [item], TotalCount: 1 }).length, 1);
    assert.equal(AppointmentsSchema.parse({ Items: [item] }).length, 1);
    assert.equal(AppointmentsSchema.parse({ Items: [], TotalCount: 0, Links: [] }).length, 0);
    assert.equal(AppointmentsSchema.parse([item]).length, 1);
  });

  it('rejects an envelope that advertises more items than it returns', () => {
    assert.equal(AppointmentsSchema.safeParse({ Items: [item], TotalCount: 2 }).success, false);
  });

  it('rejects a malformed TotalCount', () => {
    assert.equal(AppointmentsSchema.safeParse({ Items: [], TotalCount: -1 }).success, false);
    assert.equal(AppointmentsSchema.safeParse({ Items: [], TotalCount: '0' }).success, false);
  });

  it(`bounds the number of appointments at ${MAX_APPOINTMENTS}`, () => {
    assert.equal(MAX_APPOINTMENTS, 2000);
    const max = Array.from({ length: MAX_APPOINTMENTS }, () => item);
    const tooMany = [...max, item];
    assert.equal(AppointmentsSchema.safeParse({ Items: max }).success, true);
    assert.equal(AppointmentsSchema.safeParse({ Items: tooMany }).success, false);
    assert.equal(AppointmentsSchema.safeParse(tooMany).success, false);
  });
});

describe('htmlToText', () => {
  it('turns block elements into line boundaries', () => {
    assert.equal(htmlToText('<p>Een</p><p>Twee</p>'), 'Een\n\nTwee');
    assert.equal(htmlToText('regel 1<br>regel 2<br/>regel 3'), 'regel 1\nregel 2\nregel 3');
    assert.equal(htmlToText('<div>a</div><div>b</div>'), 'a\nb');
    assert.equal(htmlToText('<h2>Kop</h2>tekst'), 'Kop\n\ntekst');
    assert.equal(htmlToText('Lijst:<ul><li>een</li><li>twee</li></ul>'), 'Lijst:\n- een\n- twee');
    assert.equal(htmlToText('<ol><li><p>een</p></li></ol>'), '- een');
    assert.equal(htmlToText('<ul><li></li><li><script>x</script></li></ul>na'), 'na');
  });

  it('decodes entities', () => {
    assert.equal(
      htmlToText('a &amp; b &eacute; &#8364;5&nbsp;x &lt;tag&gt;'),
      'a & b é €5 x <tag>'
    );
  });

  for (const tag of ['script', 'style', 'iframe', 'noscript', 'template', 'svg', 'object']) {
    it(`drops the content of <${tag}>`, () => {
      assert.equal(htmlToText(`voor<${tag}>geheim<b>ook</b></${tag}>na`), 'voorna');
    });
  }

  for (const tag of ['iframe', 'object']) {
    it(`marks text hidden by a malformed self-closing <${tag}/>`, () => {
      const attr = tag === 'iframe' ? 'src' : 'data';
      assert.equal(
        htmlToText(`a<${tag} ${attr}="https://unused.invalid"/>Opgave 5`),
        `a\n\n${OMITTED_EMBED_MARKER}`
      );
    });
  }

  it('adds no marker after a properly closed embed', () => {
    assert.equal(htmlToText('a<object data="x">geheim</object>Opgave 5'), 'aOpgave 5');
  });

  it('marks nested malformed embeds once', () => {
    assert.equal(
      htmlToText('a<object data="x"/>b<iframe src="https://unused.invalid"/>c'),
      `a\n\n${OMITTED_EMBED_MARKER}`
    );
  });

  it('keeps the omission marker after truncation', () => {
    const long = htmlToText(`${'y'.repeat(MAX_CONTENT_CHARS + 5)}<iframe/>geheim`);
    assert.equal(
      long,
      `${'y'.repeat(MAX_CONTENT_CHARS)}${TRUNCATION_MARKER}\n\n${OMITTED_EMBED_MARKER}`
    );
  });

  for (const tag of ['script', 'style', 'noscript', 'template']) {
    it(`hides a malformed <${tag}/> body until its closing tag, without a marker`, () => {
      assert.equal(htmlToText(`voor<${tag}/>geheim</${tag}>na`), 'voorna');
    });
  }

  it('keeps text after nested skipped tags and an ordinary closed embed', () => {
    assert.equal(
      htmlToText('voor<object><iframe src="https://unused.invalid"></iframe>geheim</object>na'),
      'voorna'
    );
    assert.equal(htmlToText('voor<svg><style>x</style><g/>geheim</svg>na'), 'voorna');
    assert.equal(htmlToText('voor<object data="x"><svg/>geheim</object>na'), 'voorna');
    assert.equal(
      htmlToText('a<iframe src="https://unused.invalid"></iframe>Opgave 5'),
      'aOpgave 5'
    );
  });

  it('drops comments, link targets and images', () => {
    assert.equal(htmlToText('a<!-- verborgen -->b'), 'ab');
    assert.equal(htmlToText('<a href="https://x.invalid/doc">tekst</a>'), 'tekst');
    assert.equal(htmlToText('<img src="https://x.invalid/i.png" alt="plaatje">'), '');
  });

  it('handles malformed HTML and plain text', () => {
    assert.equal(htmlToText('<p>open <b>zonder sluiting'), 'open zonder sluiting');
    assert.equal(htmlToText('a < b en c > d'), 'a < b en c > d');
    assert.equal(htmlToText('Gewoon een zin.'), 'Gewoon een zin.');
    assert.equal(htmlToText(''), '');
    assert.equal(htmlToText('<script>niet gesloten'), '');
  });

  it('strips control and bidi characters and collapses whitespace', () => {
    assert.equal(htmlToText('a\u0000b\u0007c\u001bd\u007fe'), 'abcde');
    assert.equal(htmlToText('x‮y⁦z​!'), 'xyz!');
    assert.equal(htmlToText('  veel   \n\t ruimte  '), 'veel ruimte');
    assert.equal(htmlToText('<p>a</p><p></p><p></p><br><br><p>b</p>'), 'a\n\nb');
  });

  it('truncates long content with an explicit marker', () => {
    assert.equal(MAX_CONTENT_CHARS, 10_000);
    const exact = 'x'.repeat(MAX_CONTENT_CHARS);
    assert.equal(htmlToText(exact), exact);
    const long = htmlToText(`<p>${'y'.repeat(MAX_CONTENT_CHARS + 5)}</p>`);
    assert.equal(long, `${'y'.repeat(MAX_CONTENT_CHARS)}${TRUNCATION_MARKER}`);
    assert.equal(TRUNCATION_MARKER, '… [truncated]');
    // A surrogate pair is never cut in half.
    const emoji = htmlToText(`${'z'.repeat(MAX_CONTENT_CHARS - 1)}😀`);
    assert.equal(emoji, `${'z'.repeat(MAX_CONTENT_CHARS - 1)}${TRUNCATION_MARKER}`);
  });

  it('never executes markup or touches the network', () => {
    const marker = globalThis as { __assignmentProbe?: number };
    delete marker.__assignmentProbe;
    const originalFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      throw new Error('no network in tests');
    }) as typeof fetch;
    try {
      htmlToText(
        '<script>globalThis.__assignmentProbe = 1</script>' +
          '<img src="x" onerror="globalThis.__assignmentProbe = 2">' +
          '<iframe src="https://x.invalid"></iframe><link rel="stylesheet" href="https://x.invalid/s.css">'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(marker.__assignmentProbe, undefined);
    assert.equal(fetched, 0);
  });

  it('is a pure module without browser or network imports', () => {
    const source = readFileSync(new URL('../src/assignments.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import [^;]* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ['./dates.js', './magister-api.js', 'htmlparser2']);
    assert.doesNotMatch(source, /\bfetch\(|\bpage\.|playwright/);
  });
});
