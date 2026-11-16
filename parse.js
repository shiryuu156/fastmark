// fastmark — a fast drop-in for marked 18.1.3 with its default options.
//
// Forked from marked (MIT; Copyright (c) 2018+, MarkedJS; Copyright (c) 2011-2018,
// Christopher Jeffrey) and rewritten as one dependency-free ES module. The fork keeps
// marked's parsing behaviour exactly — same regexes, same tokeniser, same renderer —
// but bakes the defaults in (GFM on, breaks off, pedantic off, async off) and drops
// everything a default parse never touches: the Marked wrapper class, options merging,
// extensions, hooks and walkTokens. parse() drives the Lexer and Parser directly.
// See LICENSE (marked's MIT licence) and NOTICE for the fork credit.

/* ------------------------------------------------------------------ */
/* Regex builders                                                      */
/* ------------------------------------------------------------------ */

// Lets a regex be assembled from named pieces, like marked's `edit` helper:
// .replace('name', piece) splices the piece's source in place of `name`,
// stripping any leading ^ so the piece can sit mid-pattern.
function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const api = {
    replace(name, val) {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(misc.caret, '$1');
      source = source.replace(name, valSource);
      return api;
    },
    getRegex() {
      return new RegExp(source, opt);
    },
  };
  return api;
}

// Lookbehind assertions are used by one GFM rule when the engine has them.
// Node 22 always does; the check keeps the module honest on older engines.
const supportsLookbehind = (() => {
  try {
    return !!new RegExp('(?<=1)(?<!1)');
  } catch {
    return false;
  }
})();

// Indent-sensitive helpers (list bullets, hr, fences, headings, html,
// blockquotes) only ever need indents 0..3, so cache one regex per indent.
function cachedIndentRegex(make) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let re = cache[idx];
    if (!re) {
      re = make(idx);
      cache[idx] = re;
    }
    return re;
  };
}

// Block-level HTML tag names (CommonMark spec, HTML blocks type 6).
const tagNames = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const htmlComment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

/* ------------------------------------------------------------------ */
/* Small shared regexes                                                */
/* ------------------------------------------------------------------ */

const misc = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  // Neutralize a lazy setext underline, including one with trailing tabs.
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  // An ATX heading needs a space (or the end of the line) after the hashes, so a
  // line like `#tag` does not end a list item.
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  // A list item ends where a paragraph would be interrupted, so this mirrors the
  // html start conditions in the paragraph rule below; type 7 is excluded there.
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${tagNames})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

/* ------------------------------------------------------------------ */
/* Block grammar (GFM)                                                 */
/* ------------------------------------------------------------------ */

const newline = /^(?:[ \t]*(?:\n|$))+/;
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
// The underline may end with spaces or tabs (CommonMark §4.3). Internal
// spaces or tabs still fail to match, and more than three spaces of indent
// still do not.
const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheadingGfm = edit(lheadingCore)
  .replace(/bull/g, bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
const paragraphCore = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const blockText = /^[^\n]+/;
const blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?!\s*\n))+/;
const def = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', blockLabel)
  // An escaped delimiter is part of the title, so a backslash must consume the
  // next character. An optional closer lets that character backtrack into the
  // closing quote (`[foo]: /url "t\"` is not a title).
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const list = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bullet)
  .getRegex();

const html = edit(
  '^ {0,3}(?:' // optional indentation
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' // (1)
  + '|comment[^\\n]*(\\n+|$)' // (2)
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' // (3)
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' // (4)
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' // (5)
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (6)
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) open tag
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) closing tag
  + ')', 'i')
  .replace('comment', htmlComment)
  .replace('tag', tagNames)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

// Paragraphs stop before any block that may interrupt them. The `list` piece
// differs between top-level paragraphs (only a non-empty list from 1 interrupts)
// and blockquote paragraphs (any bare marker starts a sibling list).
function makeParagraph(listInterrupt) {
  return edit(paragraphCore)
    .replace('hr', hr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '') // setext headings don't interrupt commonmark paragraphs
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', tagNames) // paragraphs can be interrupted by html blocks of types (1) to (6)
    .getRegex();
}

const gfmTable = edit(
  '^ *([^\\n ].*)\\n' // Header
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' // Align
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)') // Cells
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]') // any bullet ends the table rows
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', tagNames) // tables can be interrupted by html blocks of types (1) to (6)
  .getRegex();

// Only non-empty lists starting from 1 can interrupt paragraphs.
const paragraph = edit(paragraphCore)
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', gfmTable) // interrupt paragraphs with table
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]') // only non-empty lists starting from 1 can interrupt
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', tagNames) // paragraphs can be interrupted by html blocks of types (1) to (6)
  .getRegex();

// Inside a blockquote a bare list marker (any number) starts a sibling list,
// so it must not be lazily continued as paragraph text (unlike a top level
// paragraph, where an empty list cannot interrupt).
const blockquoteParagraph = makeParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);

// A line with only whitespace after the marker is blank, so it must not start a
// paragraph that lazily continues onto the next line.
const blockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/ )
  .replace('paragraph', blockquoteParagraph)
  .getRegex();

const blockRules = {
  blockquote,
  code: blockCode,
  def,
  fences,
  heading,
  hr,
  html,
  lheading: lheadingGfm,
  list,
  newline,
  paragraph,
  table: gfmTable,
  text: blockText,
};

/* ------------------------------------------------------------------ */
/* Inline grammar (GFM)                                                */
/* ------------------------------------------------------------------ */

const escapeRule = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

// Unicode punctuation classes, per the CommonMark emphasis rules.
const punct = /[\p{P}\p{S}]/u;
const punctOrSpace = /[\s\p{P}\p{S}]/u;
const notPunctOrSpace = /[^\s\p{P}\p{S}]/u;
const punctuation = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, punctOrSpace).getRegex();

// GFM lets ~ sit inside strong and em for strikethrough, so the GFM
// emphasis classes exclude it.
const punctGfmStrongEm = /(?!~)[\p{P}\p{S}]/u;
const punctOrSpaceGfmStrongEm = /(?!~)[\s\p{P}\p{S}]/u;
const notPunctOrSpaceGfmStrongEm = /(?:[^\s\p{P}\p{S}]|~)/u;

// Sequences em should skip over: [title](link), `code`, <html>.
const blockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', supportsLookbehind ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;

const emStrongLDelimGfm = edit(emStrongLDelimCore, 'u')
  .replace(/punct/g, punctGfmStrongEm)
  .getRegex();

const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter

const emStrongRDelimAstGfm = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, notPunctOrSpaceGfmStrongEm)
  .replace(/punctSpace/g, punctOrSpaceGfmStrongEm)
  .replace(/punct/g, punctGfmStrongEm)
  .getRegex();

// Normal: no rule 6 for _ (a___a cannot close as emphasis).
const emStrongRDelimUnd = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // Skip orphan inside strong
  + '|[^_]+(?=[^_])' // Consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either Left or Right Delimiter
  .replace(/notPunctSpace/g, notPunctOrSpace)
  .replace(/punctSpace/g, punctOrSpace)
  .replace(/punct/g, punct)
  .getRegex();

// Tilde left delimiter for strikethrough (like emStrongLDelim for asterisk).
const delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, punct)
  .getRegex();

// Tilde delimiter patterns for strikethrough (like asterisk).
const delRDelimCore =
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter

const delRDelim = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, notPunctOrSpace)
  .replace(/punctSpace/g, punctOrSpace)
  .replace(/punct/g, punct)
  .getRegex();

const anyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, punct)
  .getRegex();

// `anyPunctuation` for the em/strong mask. A backslash is literal inside a code
// span, so a code span (matched like `inline.code`), or a backtick run that
// opens none, is matched whole and kept; only the escapes outside code spans
// are masked.
const anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, punct)
  .getRegex();

const autolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const inlineComment = edit(htmlComment).replace('(?:-->|$)', '-->').getRegex();
const tag = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // self-closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction, e.g. <?php ?>
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration, e.g. <!DOCTYPE html>
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>') // CDATA section
  .replace('comment', inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

// One matched pair of brackets, holding no bracket of its own.
const inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
// CommonMark lets the brackets in a link label nest to any depth, which a regex
// cannot follow, so it stops at a fixed one. Two levels is what the spec suite
// asks for: a third and a fourth flip no further example.
const inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', inlineLabelBrackets)
  .getRegex();

const link = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  // Same as the definition title: the escaped character is not the closer.
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const reflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', inlineLabel)
  .replace('ref', blockLabel)
  .getRegex();

const nolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', blockLabel)
  .getRegex();

// `reflink` and `nolink` are anchored, so the tokenizer tries each of them at a
// single position. `reflinkSearch` drops the anchors and runs with the global
// flag, which makes every '[' in the source a start position. The labels below
// bound that scan: `_boundedInlineLabel` limits how many escapes, code spans
// and nested brackets a link text may hold, leaving runs of ordinary characters
// unbounded so link text of any length is still found. `_boundedBlockLabel`
// limits the label itself to 999 items, which is every label CommonMark allows.
const boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', inlineLabelBrackets)
  .getRegex();

const reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', boundedInlineLabel)
    .replace('ref', boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', boundedBlockLabel)
    .getRegex())
  .getRegex();

const caseInsensitiveProtocol = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const extendedEmailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, extendedEmail)
  .getRegex();

const inlineRules = {
  anyPunctuation,
  anyPunctuationOutsideCode,
  autolink,
  blockSkip,
  br,
  code: inlineCode,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  delLDelim,
  delRDelim,
  emStrongLDelim: emStrongLDelimGfm,
  emStrongRDelimAst: emStrongRDelimAstGfm,
  emStrongRDelimUnd,
  escape: escapeRule,
  link,
  nolink,
  punctuation,
  reflink,
  reflinkSearch,
  tag,
  text: edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
    .replace('protocol', caseInsensitiveProtocol)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    // GFM: a www autolink starts only at the beginning of a line, after whitespace or after
    // `*`, `_`, `~` or `(`. Without lookbehind support, keep stopping at every `www.`.
    .replace('wwwStart', supportsLookbehind ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
    .getRegex(),
  url: edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .replace('emailProtocol', extendedEmailProtocol)
    .replace('protocol', caseInsensitiveProtocol)
    .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
    .getRegex(),
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const getEscapeReplacement = (ch) => escapeReplacements[ch];

function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (misc.escapeTest.test(html)) {
      return html.replace(misc.escapeReplace, getEscapeReplacement);
    }
  } else if (misc.escapeTest.test(html) && misc.escapeTestNoEncode.test(html)) {
    // Cheap pre-filter first: without any of & < > " ' there is nothing to
    // escape, and the precise test (with its entity lookahead) need not run.
    return html.replace(misc.escapeReplaceNoEncode, getEscapeReplacement);
  }
  return html;
}

// Numeric character references are recognized outside code and are equivalent
// to the character they name. Values that are zero, out of range, or a
// surrogate become the replacement character.
function decodeNumericCharacterReferences(text) {
  if (!misc.numericCharacterReference.test(text)) {
    return text;
  }
  // A decoded character must not join its neighbours into a new reference,
  // so every `&` that is not already one is escaped here.
  return text.replace(misc.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) {
      return '&amp;';
    }
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '�';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(misc.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  // Ensure that every cell-delimiting pipe has a space before it to
  // distinguish it from an escaped pipe.
  const row = tableRow.replace(misc.findPipe, (match, offset, str) => {
      let escaped = false;
      let curr = offset;
      while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
      if (escaped) {
        // Odd number of slashes means | is escaped, so leave it alone.
        return '|';
      }
      // Add space before unescaped |.
      return ' |';
    }),
    cells = row.split(misc.splitPipe);
  let i = 0;

  // First/last cell in a row cannot be empty if it has no leading/trailing pipe.
  if (!cells[0].trim()) {
    cells.shift();
  }
  if (cells.length > 0 && !cells.at(-1)?.trim()) {
    cells.pop();
  }

  if (count) {
    if (cells.length > count) {
      cells.splice(count);
    } else {
      while (cells.length < count) cells.push('');
    }
  }

  for (; i < cells.length; i++) {
    // Leading or trailing whitespace is ignored per the GFM spec.
    cells[i] = cells[i].trim().replace(misc.slashPipe, '|');
  }
  return cells;
}

// Remove trailing 'c's. Equivalent to str.replace(/c*$/, '').
// /c*$/ is vulnerable to REDOS.
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) {
    return '';
  }

  // Length of suffix matching the invert condition.
  let suffLen = 0;

  // Step left until we fail to match the invert condition.
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }

  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && misc.blankLine.test(lines[end])) {
    end--;
  }
  if (lines.length - end <= 2) {
    // Keep single trailing blank lines.
    return str;
  }

  return lines.slice(0, end + 1).join('\n');
}

// Normalizes a link label so definitions and references can be matched.
// CommonMark asks for a Unicode case fold, which `toLowerCase()` does not
// reach: `ẞ` lowercases to `ß` and so never meets `SS`. Round-tripping
// through upper case does, as in commonmark.js; the final `toLowerCase()`
// keeps the folded label lower case.
function normalizeLabel(label) {
  return label.trim().replace(misc.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  // An opening bracket on its own is still unbalanced, so both have to be absent.
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) {
    return -1;
  }

  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) {
        return i;
      }
    }
  }
  if (level > 0) {
    return -2;
  }

  return -1;
}

// Closer hints for one inline pass: the last `*` / `_` run that can close
// emphasis or strong, and the last `~` run that can close strikethrough.
// A run can close only when it is not preceded by ASCII whitespace or the
// start of the string. When the opener's window has no such run, the regex
// scan cannot succeed, so the opener bails out early. Held only while a
// pass runs, keyed by tokenizer instance so parses never share frames.
const closerHintStacks = new WeakMap();

function scanLastPossibleClosers(src) {
  const lastEmStrong = { '*': -1, _: -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') {
      continue;
    }
    // A leading run has no predecessor, same as one after a line break.
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) {
      j++;
    }
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') {
        lastDel = i;
      } else {
        lastEmStrong[ch] = i;
      }
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEmStrong, lastDel };
}

function beginCloserScan(tokenizer, maskedSrc) {
  const frame = scanLastPossibleClosers(maskedSrc);
  const stack = closerHintStacks.get(tokenizer);
  if (stack) {
    stack.push(frame);
  } else {
    closerHintStacks.set(tokenizer, [frame]);
  }
}

function endCloserScan(tokenizer) {
  const stack = closerHintStacks.get(tokenizer);
  if (!stack) {
    return;
  }
  stack.pop();
  if (stack.length === 0) {
    closerHintStacks.delete(tokenizer);
  }
}

function lastPossibleEmStrongCloser(tokenizer, maskedSrc, delim) {
  const frame = closerHintStacks.get(tokenizer)?.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastEmStrong[delim];
  }
  return scanLastPossibleClosers(maskedSrc).lastEmStrong[delim];
}

function lastPossibleDelCloser(tokenizer, maskedSrc) {
  const frame = closerHintStacks.get(tokenizer)?.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastDel;
  }
  return scanLastPossibleClosers(maskedSrc).lastDel;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }

  return expanded;
}

// The part of `s` before its first newline — exactly s.split('\n', 1)[0],
// without building the array.
function uptoNewline(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

// Index of the first non-space character of `line` after expanding tabs to
// 4 spaces — exactly what line.replace(/\t/g, '    ').search(/[^ ]/)
// computes, without building the expanded string. -1 when the line holds
// no such character.
function expandedIndent(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4;
    else return col;
  }
  return -1;
}

// Exactly what !s.trim() computes: true when the string holds only
// whitespace (the White_Space set plus line terminators), without
// allocating the trimmed copy.
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13
      || c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
      || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f
      || c === 0x3000 || c === 0xfeff) continue;
    return false;
  }
  return true;
}

// Exactly what /\n[ \t]*\n[ \t]*$/.test(raw) computes: the text ends with
// two newlines separated (and followed) only by spaces or tabs.
function endsWithDoubleBlank(raw) {
  let i = raw.length;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  if (i === 0 || raw[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  if (i === 0 || raw[i - 1] !== '\n') return false;
  return true;
}

// Exactly what /\n.*\n/.test(s) computes: `.*` cannot cross a newline, so
// this is true iff the string holds at least two newlines.
function hasTwoNewlines(s) {
  const first = s.indexOf('\n');
  return first !== -1 && s.indexOf('\n', first + 1) !== -1;
}

/* ------------------------------------------------------------------ */
/* Link output + small tokeniser helpers                               */
/* ------------------------------------------------------------------ */

function outputLink(cap, link, raw, lexer) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(misc.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = lexer.state.inLink;
  const outerLinkEmitted = lexer.state.linkEmitted;
  const outerInRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const textHasLink = lexer.state.linkEmitted;
  lexer.state.linkEmitted = outerLinkEmitted;
  lexer.state.inLink = outerInLink;

  if (!isImage) {
    // CommonMark: "Links may not contain other links, at any level of nesting."
    // Bail so the caller falls through to text and the inner link is the one kept.
    // Images are exempt: their text is flattened into an alt attribute.
    if (textHasLink) {
      // These tokens are discarded, so undo the raw-block state they opened;
      // leaving it set would suppress escaping for the text that is re-scanned.
      lexer.state.inRawBlock = outerInRawBlock;
      return;
    }
    lexer.state.linkEmitted = true;
  }

  return {
    type: isImage ? 'image' : 'link',
    raw,
    href,
    title,
    text,
    tokens,
  };
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(misc.indentCodeCompensation);

  if (matchIndentToCode === null) {
    return text;
  }

  const indentToCode = matchIndentToCode[1];

  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(misc.beginningSpace);
      if (matchIndentInNode === null) {
        return node;
      }

      const [indentInNode] = matchIndentInNode;

      // Up to the fence's own indentation is removed from each line, so a line
      // indented less than the fence loses whatever indentation it has.
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) {
    return false;
  }

  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }

    if (label[i] === '`') {
      const code = inlineRules.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }

    if (label[i] !== '<') {
      continue;
    }

    const tokenSrc = src.slice(labelStart + i);
    const token = inlineRules.tag.exec(tokenSrc) || inlineRules.autolink.exec(tokenSrc);
    if (!token) {
      continue;
    }

    if (token[0].length > label.length - i) {
      return true;
    }
    i += token[0].length - 1;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Tokenizer — block level                                             */
/* ------------------------------------------------------------------ */

class Tokenizer {
  constructor() {
    // The lexer wires itself in; rules live at module scope.
    this.lexer = null;
  }

  space(src) {
    const cap = blockRules.newline.exec(src);
    if (cap && cap[0].length > 0) {
      return {
        type: 'space',
        raw: cap[0],
      };
    }
  }

  code(src) {
    const cap = blockRules.code.exec(src);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      const text = raw.replace(misc.codeRemoveIndent, '');
      return {
        type: 'code',
        raw,
        codeBlockStyle: 'indented',
        text,
      };
    }
  }

  fences(src) {
    const cap = blockRules.fences.exec(src);
    if (cap) {
      const raw = cap[0];
      const text = indentCodeCompensation(raw, cap[3] || '');

      return {
        type: 'code',
        raw,
        lang: cap[2] ? cap[2].trim().replace(inlineRules.anyPunctuation, '$1') : cap[2],
        text,
      };
    }
  }

  heading(src) {
    const cap = blockRules.heading.exec(src);
    if (cap) {
      let text = cap[2].trim();

      // Remove trailing #s.
      if (misc.endingHash.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || misc.endingSpaceTabChar.test(trimmed)) {
          // CommonMark requires a space or tab before trailing #s.
          text = trimmed.trim();
        }
      }

      return {
        type: 'heading',
        raw: rtrim(cap[0], '\n'),
        depth: cap[1].length,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  hr(src) {
    const cap = blockRules.hr.exec(src);
    if (cap) {
      return {
        type: 'hr',
        raw: rtrim(cap[0], '\n'),
      };
    }
  }

  blockquote(src) {
    const cap = blockRules.blockquote.exec(src);
    if (cap) {
      let lines = rtrim(cap[0], '\n').split('\n');
      let raw = '';
      let text = '';
      const tokens = [];

      while (lines.length > 0) {
        let inBlockquote = false;
        const currentLines = [];

        let i;
        for (i = 0; i < lines.length; i++) {
          // Get lines up to a continuation.
          if (misc.blockquoteStart.test(lines[i])) {
            currentLines.push(lines[i]);
            inBlockquote = true;
          } else if (!inBlockquote) {
            currentLines.push(lines[i]);
          } else {
            break;
          }
        }
        lines = lines.slice(i);

        const currentRaw = currentLines.join('\n');
        const currentText = currentRaw
          // A tab after the block quote marker runs to the next tab stop, and
          // the marker only consumes one space of it; the rest is content.
          .replace(
            misc.blockquoteMarkerWhitespace,
            (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
          )
          // Precede setext continuation with 4 spaces so it isn't a setext.
          .replace(misc.blockquoteSetextReplace, '\n    $1')
          .replace(misc.blockquoteSetextReplace2, '');
        raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
        text = text ? `${text}\n${currentText}` : currentText;

        // Parse blockquote lines as top level tokens.
        // Merge paragraphs if this is a continuation.
        const top = this.lexer.state.top;
        this.lexer.state.top = true;
        this.lexer.blockTokens(currentText, tokens, true);
        this.lexer.state.top = top;

        // If there is no continuation then we are done.
        if (lines.length === 0) {
          break;
        }

        const lastToken = tokens.at(-1);

        if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
          // Blockquote continuation cannot be preceded by a code block, heading, hr, html block or table.
          break;
        } else if (lastToken?.type === 'blockquote') {
          // Include continuation in nested blockquote.
          const oldToken = lastToken;
          // The continuation lines belong to the same nesting frame as the
          // nested blockquote, which already had one '>' marker stripped, so
          // strip one marker from them too. Otherwise a restated marker after a
          // lazy line is re-parsed as a spurious deeper blockquote.
          const continuation = lines.join('\n');
          const newText = oldToken.raw + '\n' + continuation.replace(misc.blockquoteSetextReplace2, '');
          const newToken = this.blockquote(newText);
          tokens[tokens.length - 1] = newToken;

          // Only include continuation lines the nested blockquote actually
          // consumed. Unconsumed trailing lines must stay out of `raw` so the
          // lexer can still tokenize them (paragraph, next blockquote, etc.).
          const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
          const leftoverCount = leftover ? leftover.split('\n').length : 0;
          const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
          if (consumed.length > 0) {
            raw = `${raw}\n${consumed.join('\n')}`;
          }
          text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

          // A leftover line that starts with '>' still belongs to this
          // blockquote; any other leftover line ends it.
          lines = lines.slice(consumed.length);
          if (lines.length > 0 && misc.blockquoteStart.test(lines[0])) {
            continue;
          }
          break;
        } else if (lastToken?.type === 'list') {
          // Include continuation in nested list.
          const oldToken = lastToken;
          const newText = oldToken.raw + '\n' + lines.join('\n');
          const newToken = this.list(newText);
          tokens[tokens.length - 1] = newToken;

          // The list raw has no '>' markers, so it cannot be cut out of `raw`.
          // Count the continuation lines the list took and add those lines instead.
          const consumedCount = newToken.raw.length > oldToken.raw.length
            ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
            : 0;
          if (consumedCount > 0) {
            const consumed = lines.slice(0, consumedCount).join('\n');
            raw = `${raw}\n${consumed}`;
            text = `${text}\n${consumed}`;
          }
          lines = lines.slice(consumedCount);
          continue;
        }
      }

      return {
        type: 'blockquote',
        raw,
        tokens,
        text,
      };
    }
  }

  list(src) {
    let cap = blockRules.list.exec(src);
    if (cap) {
      // src is only consumed from the front, so every raw below is a slice of
      // listSrc rather than a string built up line by line.
      const listSrc = src;
      const taken = () => listSrc.length - src.length;
      let bull = cap[1].trim();
      const isordered = bull.length > 1;

      const list = {
        type: 'list',
        raw: '',
        ordered: isordered,
        start: isordered ? +bull.slice(0, -1) : '',
        loose: false,
        items: [],
      };

      bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

      // Get next list item.
      const itemRegex = misc.listItemRegex(bull);
      let endsWithBlankLine = false;
      // Check if current bullet point can start a new List Item.
      while (src) {
        let endEarly = false;
        let itemContents = '';
        if (!(cap = itemRegex.exec(src))) {
          break;
        }

        if (blockRules.hr.test(src)) { // End list if bullet was actually HR.
          break;
        }

        const itemStart = taken();
        src = src.substring(cap[0].length);

        const firstLine = uptoNewline(cap[2]);
        const bulletIndent = cap[1].length;
        let line = firstLine.replace(misc.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent));
        let nextLine = uptoNewline(src);
        let blankLine = isBlankLine(line);

        let indent = 0;
        if (blankLine) {
          indent = bulletIndent + 1;
        } else {
          indent = line.search(misc.nonSpaceChar); // Find first non-space char.
          indent = indent > 4 ? 1 : indent; // Treat indented code blocks (> 4 spaces) as having only 1 indent.
          itemContents = line.slice(indent);
          indent += bulletIndent;
        }

        if (blankLine && misc.blankLine.test(nextLine)) { // Items begin with at most one blank line.
          src = src.substring(nextLine.length + 1);
          endEarly = true;
        }

        if (!endEarly) {
          const nextBulletRegex = misc.nextBulletRegex(indent);
          const hrRegex = misc.hrRegex(indent);
          const fencesBeginRegex = misc.fencesBeginRegex(indent);
          const headingBeginRegex = misc.headingBeginRegex(indent);
          const htmlBeginRegex = misc.htmlBeginRegex(indent);
          const blockquoteBeginRegex = misc.blockquoteBeginRegex(indent);

          // Check if following lines should be included in List Item.
          while (src) {
            const rawLine = uptoNewline(src);
            nextLine = rawLine;

            // The six "end of item" tests below are all anchored to a marker
            // character after at most `indent` spaces. Find the first
            // non-space character (a tab breaks the run: the patterns only
            // allow literal spaces) and run only the tests that character
            // could pass; a letter or other ordinary character passes none.
            // Every test just breaks, so their order does not matter.
            let leadSpaces = 0;
            while (leadSpaces < nextLine.length && leadSpaces <= indent && nextLine[leadSpaces] === ' ') leadSpaces++;
            const marker = leadSpaces <= indent ? nextLine.charCodeAt(leadSpaces) : -1;
            if (marker === 96 || marker === 126) { // ` or ~: fences
              if (fencesBeginRegex.test(nextLine)) break;
            } else if (marker === 35) { // #: heading
              if (headingBeginRegex.test(nextLine)) break;
            } else if (marker === 60) { // <: html block
              if (htmlBeginRegex.test(nextLine)) break;
            } else if (marker === 62) { // >: blockquote
              if (blockquoteBeginRegex.test(nextLine)) break;
            } else if (marker === 42 || marker === 43 || marker === 45 || (marker >= 48 && marker <= 57)) { // bullet, maybe hr
              if (nextBulletRegex.test(nextLine)) break;
              if ((marker === 42 || marker === 45) && hrRegex.test(nextLine)) break;
            } else if (marker === 95) { // _: hr
              if (hrRegex.test(nextLine)) break;
            }

            // Re-align to follow commonmark nesting rules.
            const nextLineWithoutTabs = nextLine.replace(misc.leadingSpaceTab, (whitespace) => expandTabs(whitespace));
            const lineIsBlank = isBlankLine(nextLine);
            let firstNonSpace = -1;
            for (let k = 0; k < nextLineWithoutTabs.length; k++) {
              if (nextLineWithoutTabs[k] !== ' ') { firstNonSpace = k; break; }
            }

            if (firstNonSpace >= indent || lineIsBlank) { // Dedent if possible.
              itemContents += '\n' + nextLineWithoutTabs.slice(indent);
            } else {
              // Not enough indentation.
              if (blankLine) {
                break;
              }

              // Paragraph continuation unless last line was a different block level element.
              if (expandedIndent(line) >= 4) { // Indented code block.
                break;
              }
              // Same first-character dispatch as above, on the previous line
              // (only fences, heading, html and hr can end the item here).
              let lineLead = 0;
              while (lineLead < line.length && lineLead <= indent && line[lineLead] === ' ') lineLead++;
              const lineMarker = lineLead <= indent ? line.charCodeAt(lineLead) : -1;
              if (lineMarker === 96 || lineMarker === 126) {
                if (fencesBeginRegex.test(line)) break;
              } else if (lineMarker === 35) {
                if (headingBeginRegex.test(line)) break;
              } else if (lineMarker === 60) {
                if (htmlBeginRegex.test(line)) break;
              } else if (lineMarker === 42 || lineMarker === 45 || lineMarker === 95) {
                if (hrRegex.test(line)) break;
              }

              // A lazy continuation can look like a setext underline after
              // list indentation is removed. Keep it in the paragraph.
              const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
                && blockRules.lheading.test(`${line}\n${nextLine}`);
              const continuation = setextContinuation
                ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
                : nextLine;
              itemContents += '\n' + continuation;
            }

            blankLine = lineIsBlank;

            src = src.substring(rawLine.length + 1);
            line = nextLineWithoutTabs.slice(indent);
          }
        }

        // The loops above appended a '\n' the source may not have had. It could
        // only land on the item that exhausts src, whose raw is trimmed below,
        // and after which nothing reads endsWithBlankLine.
        const raw = listSrc.slice(itemStart, taken());

        if (!list.loose) {
          // If the previous item ended with a blank line, the list is loose.
          if (endsWithBlankLine) {
            list.loose = true;
          } else if (endsWithDoubleBlank(raw)) {
            endsWithBlankLine = true;
          }
        }

        list.items.push({
          type: 'list_item',
          raw,
          task: misc.listIsTask.test(itemContents),
          loose: false,
          text: itemContents,
          tokens: [],
        });
      }

      // Do not consume newlines at end of final item.
      const lastItem = list.items.at(-1);
      if (lastItem) {
        lastItem.raw = lastItem.raw.trimEnd();
        lastItem.text = lastItem.text.trimEnd();
      } else {
        // Not a list since there were no items.
        return;
      }
      list.raw = listSrc.slice(0, taken()).trimEnd();

      // Item child tokens handled here at end because we needed to have the final item to trim it first.
      // First pass: tokenize items and finalize list.loose from spacers before placing checkboxes.
      for (const item of list.items) {
        this.lexer.state.top = false;
        item.tokens = this.lexer.blockTokens(item.text, []);

        if (!list.loose) {
          // Check if list should be loose.
          const spacers = item.tokens.filter((t) => t.type === 'space');
          const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => hasTwoNewlines(t.raw));

          list.loose = hasMultipleLineBreaks;
        }
      }

      // Second pass: place task checkboxes using the final list.loose.
      for (const item of list.items) {
        const itemToken = item.tokens[0];
        if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
          // Remove checkbox markdown from item tokens.
          item.text = item.text.replace(misc.listReplaceTask, '');
          itemToken.raw = itemToken.raw.replace(misc.listReplaceTask, '');
          itemToken.text = itemToken.text.replace(misc.listReplaceTask, '');
          for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
            if (misc.listIsTask.test(this.lexer.inlineQueue[i].src)) {
              this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(misc.listReplaceTask, '');
              break;
            }
          }

          const taskRaw = misc.listTaskCheckbox.exec(item.raw);
          if (taskRaw) {
            const checkboxToken = {
              type: 'checkbox',
              raw: taskRaw[0] + ' ',
              checked: taskRaw[0] !== '[ ]',
            };
            item.checked = checkboxToken.checked;
            if (list.loose) {
              if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
                item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
                item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
                item.tokens[0].tokens.unshift(checkboxToken);
              } else {
                item.tokens.unshift({
                  type: 'paragraph',
                  raw: checkboxToken.raw,
                  text: checkboxToken.raw,
                  tokens: [checkboxToken],
                });
              }
            } else {
              item.tokens.unshift(checkboxToken);
            }
          }
        } else if (item.task) {
          item.task = false;
        }
      }

      // Set all items to loose if list is loose.
      if (list.loose) {
        for (const item of list.items) {
          item.loose = true;
          for (const token of item.tokens) {
            if (token.type === 'text') {
              token.type = 'paragraph';
            }
          }
        }
      }

      return list;
    }
  }

  html(src) {
    const cap = blockRules.html.exec(src);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      const token = {
        type: 'html',
        block: true,
        raw,
        pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
        text: raw,
      };
      return token;
    }
  }

  def(src) {
    const cap = blockRules.def.exec(src);
    if (cap) {
      // Outside angle brackets a link destination holds only balanced parentheses.
      if (!misc.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
        return;
      }

      const tag = normalizeLabel(cap[1]);
      const href = cap[2] ? cap[2].replace(misc.hrefBrackets, '$1').replace(inlineRules.anyPunctuation, '$1') : '';
      const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(inlineRules.anyPunctuation, '$1') : cap[3];
      return {
        type: 'def',
        tag,
        raw: rtrim(cap[0], '\n'),
        href,
        title,
      };
    }
  }

  table(src) {
    const cap = blockRules.table.exec(src);
    if (!cap) {
      return;
    }

    if (!misc.tableDelimiter.test(cap[2])) {
      // Delimiter row must have a pipe (|) or colon (:) otherwise it is a setext heading.
      return;
    }

    const headers = splitCells(cap[1]);
    const aligns = cap[2].replace(misc.tableAlignChars, '').split('|');
    const rows = cap[3]?.trim() ? cap[3].replace(misc.tableRowBlankLine, '').split('\n') : [];

    const item = {
      type: 'table',
      raw: rtrim(cap[0], '\n'),
      header: [],
      align: [],
      rows: [],
    };

    if (headers.length !== aligns.length) {
      // Header and align columns must be equal, rows can be different.
      return;
    }

    for (const align of aligns) {
      if (misc.tableAlignRight.test(align)) {
        item.align.push('right');
      } else if (misc.tableAlignCenter.test(align)) {
        item.align.push('center');
      } else if (misc.tableAlignLeft.test(align)) {
        item.align.push('left');
      } else {
        item.align.push(null);
      }
    }

    for (let i = 0; i < headers.length; i++) {
      item.header.push({
        text: headers[i],
        tokens: this.lexer.inline(headers[i]),
        header: true,
        align: item.align[i],
      });
    }

    for (const row of rows) {
      item.rows.push(splitCells(row, item.header.length).map((cell, i) => {
        return {
          text: cell,
          tokens: this.lexer.inline(cell),
          header: false,
          align: item.align[i],
        };
      }));
    }

    return item;
  }

  lheading(src) {
    const cap = blockRules.lheading.exec(src);
    if (cap) {
      const text = cap[1].trim();
      return {
        type: 'heading',
        raw: rtrim(cap[0], '\n'),
        depth: cap[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  paragraph(src) {
    const cap = blockRules.paragraph.exec(src);
    if (cap) {
      const text = cap[1].charAt(cap[1].length - 1) === '\n'
        ? cap[1].slice(0, -1)
        : cap[1];
      return {
        type: 'paragraph',
        raw: cap[0],
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  text(src) {
    const cap = blockRules.text.exec(src);
    if (cap) {
      return {
        type: 'text',
        raw: cap[0],
        text: cap[0],
        tokens: this.lexer.inline(cap[0]),
      };
    }
  }

  /* -------------------------------------------------------------- */
  /* Inline level                                                    */
  /* -------------------------------------------------------------- */

  escape(src) {
    const cap = inlineRules.escape.exec(src);
    if (cap) {
      return {
        type: 'escape',
        raw: cap[0],
        text: cap[1],
      };
    }
  }

  tag(src) {
    const cap = inlineRules.tag.exec(src);
    if (cap) {
      if (!this.lexer.state.inLink && misc.startATag.test(cap[0])) {
        this.lexer.state.inLink = true;
      } else if (this.lexer.state.inLink && misc.endATag.test(cap[0])) {
        this.lexer.state.inLink = false;
      }
      if (!this.lexer.state.inRawBlock && misc.startPreScriptTag.test(cap[0])) {
        this.lexer.state.inRawBlock = true;
      } else if (this.lexer.state.inRawBlock && misc.endPreScriptTag.test(cap[0])) {
        this.lexer.state.inRawBlock = false;
      }

      return {
        type: 'html',
        raw: cap[0],
        inLink: this.lexer.state.inLink,
        inRawBlock: this.lexer.state.inRawBlock,
        block: false,
        text: cap[0],
      };
    }
  }

  link(src) {
    // The link regex backtracks quadratically over unterminated-link inputs
    // like '[a](b'.repeat(n): at every '[' its greedy unquoted-href run
    // re-partitions the whole remainder while hunting for a ')' that never
    // comes. inlineTokens anchors one paren scan per run in
    // state.linkParenPossible; when it is false the regex cannot match, so
    // bail out before running it.
    if (this.lexer.state.linkParenPossible === false) {
      return undefined;
    }
    const cap = inlineRules.link.exec(src);
    if (cap) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (isLabelEndInsideToken(src, cap[1], labelStart)) {
        return;
      }

      const trimmedUrl = cap[2].trim();
      if (misc.startAngleBracket.test(trimmedUrl)) {
        // Commonmark requires matching angle brackets.
        if (!(misc.endAngleBracket.test(trimmedUrl))) {
          return;
        }

        // Ending angle bracket cannot be escaped.
        const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
        if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
          return;
        }
      } else {
        // Find closing parenthesis.
        const lastParenIndex = findClosingBracket(cap[2], '()');
        if (lastParenIndex === -2) {
          // More open parens than closed.
          return;
        }

        if (lastParenIndex > -1) {
          const start = cap[0].indexOf('!') === 0 ? 5 : 4;
          const linkLen = start + cap[1].length + lastParenIndex;
          cap[2] = cap[2].substring(0, lastParenIndex);
          cap[0] = cap[0].substring(0, linkLen).trim();
          cap[3] = '';
        }
      }
      // The ')' that ends the match is the link closer only when it is not
      // escaped. `[foo](/url\)` has no closer; that paren is destination text.
      const unescaped = rtrim(cap[0].slice(0, -1), '\\');
      if ((cap[0].length - unescaped.length) % 2 === 0) {
        return;
      }
      let href = cap[2];
      const title = cap[3] ? cap[3].slice(1, -1) : '';

      href = href.trim();
      if (misc.startAngleBracket.test(href)) {
        href = href.slice(1, -1);
      }
      return outputLink(cap, {
        href: href ? href.replace(inlineRules.anyPunctuation, '$1') : href,
        title: title ? title.replace(inlineRules.anyPunctuation, '$1') : title,
      }, cap[0], this.lexer);
    }
  }

  reflink(src, links) {
    let cap;
    if ((cap = inlineRules.reflink.exec(src))
      || (cap = inlineRules.nolink.exec(src))) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (isLabelEndInsideToken(src, cap[1], labelStart)) {
        return;
      }

      const link = links[normalizeLabel(cap[2] || cap[1])];
      if (!link) {
        const text = cap[0].charAt(0);
        return {
          type: 'text',
          raw: text,
          text,
        };
      }
      return outputLink(cap, link, cap[0], this.lexer);
    }
  }

  emStrong(src, maskedSrc, prevChar = '') {
    let match = inlineRules.emStrongLDelim.exec(src);
    if (!match) return;
    if (!match[1] && !match[2] && !match[3] && !match[4]) return;

    const delimChar = match[0][0];
    // A mid-run opener (for example the second star of an unmatched `**`) must
    // only pair with a delimiter that can only close, otherwise it steals the
    // opener of a later span (`**a*b*c` must be `**a<em>b</em>c`).
    const midRun = prevChar === delimChar;

    // The start of this delimiter run may already be behind src, either taken
    // as text after the whole run failed to match or used to close an earlier
    // span. Flanking and rules 9-10 are about the whole run, so find its start.
    const srcStart = maskedSrc.length - src.length;
    let runStart = srcStart;
    while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) {
      runStart--;
    }
    // The last code point before the run (a surrogate pair counts as one).
    const runPrevSlice = maskedSrc.slice(Math.max(0, runStart - 2), runStart);
    const runPrevChar = runPrevSlice.length === 0 ? ''
      : (runPrevSlice.length === 2 && runPrevSlice.charCodeAt(0) >= 0xd800 && runPrevSlice.charCodeAt(0) <= 0xdbff
        && runPrevSlice.charCodeAt(1) >= 0xdc00 && runPrevSlice.charCodeAt(1) <= 0xdfff
        ? runPrevSlice : runPrevSlice.slice(-1));
    // The other delimiter character counts as punctuation here (`_**a*`).
    const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!inlineRules.punctuation.exec(runPrevChar);
    if (runStart < srcStart) {
      prevChar = runPrevChar;
    }
    const prevPunct = runStart < srcStart ? runPrevPunct : !!inlineRules.punctuation.exec(prevChar);

    // _ can't be between two alphanumerics. \p{L}\p{N} includes non-english alphabet/numbers as well.
    if (match[4] && prevChar.match(misc.unicodeAlphaNumeric)) return;

    const nextChar = match[1] || match[3] || '';

    if (!nextChar || !prevChar || prevPunct) {
      // The opener is a run of ASCII delimiters plus one trailing code
      // point, so its length is the match length minus one, minus one more
      // when that trailing code point is astral (two code units).
      let lLength = match[0].length - 1;
      if (match[0].codePointAt(match[0].length - 2) > 0xffff) lLength--;
      let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

      // Rules 9-10 count the whole run, and also apply when the opener could
      // close as well (`a*b**`, where `*` is both left- and right-flanking).
      const runLength = srcStart - runStart + lLength;
      const openerCanClose = !!runPrevChar.trim()
        && (!!nextChar || (delimChar === '*' && !runPrevPunct));
      const endReg = delimChar === '*' ? inlineRules.emStrongRDelimAst : inlineRules.emStrongRDelimUnd;
      const lastPossibleCloser = lastPossibleEmStrongCloser(this, maskedSrc, delimChar);
      const closerWindowStart = maskedSrc.length - src.length + lLength;
      if (lastPossibleCloser < closerWindowStart) return;
      // Clip maskedSrc to same section of string as src.
      maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
      const lastPossibleCloserInWindow = lastPossibleCloser - closerWindowStart;
      endReg.lastIndex = 0;

      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastPossibleCloserInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue; // Skip single * in __abc*abc__.

        rLength = rDelim.length; // A delimiter run is ASCII only.

        if (match[3] || match[4]) { // Found another Left Delim.
          delimTotal += rLength;
          continue;
        } else if (match[5] || match[6] || openerCanClose) { // Either Left or Right Delim.
          if (midRun && (match[5] || match[6])) {
            // A mid-run opener cannot close against an ambiguous delimiter that
            // can also open; that delimiter opens its own emphasis span instead.
            break;
          }
          if (runLength % 3 && !((runLength + rLength) % 3)) {
            midDelimTotal += rLength;
            continue; // CommonMark Emphasis Rules 9-10.
          }
        }

        delimTotal -= rLength;

        if (delimTotal > 0) continue; // Haven't found enough closing delimiters.

        // Remove extra characters. *a*** -> *a*
        rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
        // Char length can be >1 for unicode characters.
        const lastCharLength = match[0].codePointAt(0) > 0xffff ? 2 : 1;
        const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

        // Create `em` if smallest delimiter has odd char count. *a***
        if (Math.min(lLength, rLength) % 2) {
          const text = raw.slice(1, -1);
          return {
            type: 'em',
            raw,
            text,
            tokens: this.lexer.inlineTokens(text),
          };
        }

        // Create 'strong' if smallest delimiter has even char count. **a***
        const text = raw.slice(2, -2);
        return {
          type: 'strong',
          raw,
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      }
    }
  }

  codespan(src) {
    const cap = inlineRules.code.exec(src);
    if (cap) {
      let text = cap[2].replace(misc.newLineCharGlobal, ' ');
      const hasNonSpaceChars = misc.nonSpaceChar.test(text);
      const hasSpaceCharsOnBothEnds = misc.startingSpaceChar.test(text) && misc.endingSpaceChar.test(text);
      if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
        text = text.substring(1, text.length - 1);
      }
      return {
        type: 'codespan',
        raw: cap[0],
        text,
      };
    }
  }

  br(src) {
    const cap = inlineRules.br.exec(src);
    if (cap) {
      return {
        type: 'br',
        raw: cap[0],
      };
    }
  }

  del(src, maskedSrc, prevChar = '') {
    let match = inlineRules.delLDelim.exec(src);
    if (!match) return;

    const nextChar = match[1] || '';

    if (!nextChar || !prevChar || inlineRules.punctuation.exec(prevChar)) {
      // The opener is a run of ASCII tildes plus one trailing code point,
      // so its length is the match length minus one, minus one more when
      // that trailing code point is astral (two code units).
      let lLength = match[0].length - 1;
      if (match[0].codePointAt(match[0].length - 2) > 0xffff) lLength--;
      let rDelim, rLength, delimTotal = lLength;

      const endReg = inlineRules.delRDelim;
      const lastPossibleCloser = lastPossibleDelCloser(this, maskedSrc);
      const closerWindowStart = maskedSrc.length - src.length + lLength;
      if (lastPossibleCloser < closerWindowStart) return;
      // Clip maskedSrc to same section of string as src.
      maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
      const lastPossibleCloserInWindow = lastPossibleCloser - closerWindowStart;
      endReg.lastIndex = 0;

      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastPossibleCloserInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue;

        rLength = rDelim.length; // A delimiter run is ASCII only.

        if (rLength !== lLength) continue;

        if (match[3] || match[4]) { // Found another Left Delim.
          delimTotal += rLength;
          continue;
        }

        delimTotal -= rLength;

        if (delimTotal > 0) continue; // Haven't found enough closing delimiters.

        // Remove extra characters.
        rLength = Math.min(rLength, rLength + delimTotal);
        // Char length can be >1 for unicode characters.
        const lastCharLength = match[0].codePointAt(0) > 0xffff ? 2 : 1;
        const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

        // Create del token - only single ~ or double ~~ supported.
        const text = raw.slice(lLength, -lLength);
        return {
          type: 'del',
          raw,
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      }
    }
  }

  autolink(src) {
    const cap = inlineRules.autolink.exec(src);
    if (cap) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[1];
        href = 'mailto:' + text;
      } else {
        text = cap[1];
        href = text;
      }

      return {
        type: 'link',
        raw: cap[0],
        text,
        href,
        autolink: true,
        tokens: [
          {
            type: 'text',
            raw: text,
            text,
          },
        ],
      };
    }
  }

  url(src) {
    let cap;
    if (cap = inlineRules.url.exec(src)) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[0];
        href = 'mailto:' + text;
      } else {
        // Do extended autolink path validation.
        let prevCapZero;
        do {
          prevCapZero = cap[0];
          cap[0] = inlineRules._backpedal.exec(cap[0])?.[0] ?? '';
        } while (prevCapZero !== cap[0]);
        text = cap[0];
        if (cap[1] === 'www.') {
          href = 'http://' + cap[0];
        } else {
          href = cap[0];
        }
      }
      return {
        type: 'link',
        raw: cap[0],
        text,
        href,
        autolink: true,
        tokens: [
          {
            type: 'text',
            raw: text,
            text,
          },
        ],
      };
    }
  }

  inlineText(src) {
    const cap = inlineRules.text.exec(src);
    if (cap) {
      const escaped = this.lexer.state.inRawBlock;
      return {
        type: 'text',
        raw: cap[0],
        // Raw HTML keeps whatever it was written with, everywhere else a numeric
        // character reference stands for the character itself.
        text: escaped ? cap[0] : decodeNumericCharacterReferences(cap[0]),
        escaped,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* First-character dispatch tables                                     */
/* ------------------------------------------------------------------ */

// Inline loop: which tokenizers can match at a given starting character.
// 0 = backslash, 1 = '<', 2 = '[' or '!', 3 = '*' or '_', 4 = backtick,
// 5 = '~', 6 = space, 7 = anything else. Every inline tokenizer except
// `text` (and `url`, which needs a letter, digit or . _ + -) is anchored
// to one of these, so the loop only runs the tokenizers that can match.
const inlineBucket = new Uint8Array(128).fill(7);
inlineBucket[92] = 0; // backslash
inlineBucket[60] = 1; // <
inlineBucket[91] = 2; inlineBucket[33] = 2; // [ !
inlineBucket[42] = 3; inlineBucket[95] = 3; // * _
inlineBucket[96] = 4; // backtick
inlineBucket[126] = 5; // ~
inlineBucket[32] = 6; // space

// Block loop: 1 when a block tokenizer other than table/lheading/paragraph/
// text could match at this character (space, tab, newline, or a marker).
// Characters at code 128 and above are never special here.
const blockSpecial = new Uint8Array(128);
for (const c of [9, 10, 32, 35, 42, 43, 45, 60, 62, 91, 95, 96, 126]) blockSpecial[c] = 1;
for (let c = 48; c <= 57; c++) blockSpecial[c] = 1;

/* ------------------------------------------------------------------ */
/* Lexer — block and inline passes                                     */
/* ------------------------------------------------------------------ */

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new Tokenizer();
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
  }

  // Preprocessing: normalise line endings, lex blocks, then drain the
  // queued inline passes in order.
  lex(src) {
    src = src.replace(misc.carriageReturn, '\n');

    this.blockTokens(src, this.tokens);

    for (let i = 0; i < this.inlineQueue.length; i++) {
      const next = this.inlineQueue[i];
      // An inline <pre>, <code>, <kbd> or <script> left open ends with the block
      // holding it; carried over, it would stop every later block's text from
      // being escaped.
      this.state.inRawBlock = false;
      this.inlineTokens(next.src, next.tokens);
    }
    this.inlineQueue = [];

    return this.tokens;
  }

  blockTokens(src, tokens = [], lastParagraphClipped = false) {
    this.tokenizer.lexer = this;

    let srcLength = Infinity;
    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      }

      let token;

      // Dispatch on the first character: space, code, fences, heading, hr,
      // blockquote, list, html and def are all anchored to a space, tab,
      // newline or a specific marker character. When the input starts with
      // anything else, only table, lheading, paragraph and text can match,
      // so the rest are skipped.
      const c0 = src.charCodeAt(0);
      const plainStart = c0 >= 128 || blockSpecial[c0] === 0;

      // newline
      if (!plainStart && (token = this.tokenizer.space(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.raw.length === 1 && lastToken !== undefined) {
          // If there's a single \n as a spacer, it's terminating the last line,
          // so move it there so that we don't get unnecessary paragraph tags.
          lastToken.raw += '\n';
        } else {
          tokens.push(token);
        }
        continue;
      }

      // code
      if (!plainStart && (token = this.tokenizer.code(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        // An indented code block cannot interrupt a paragraph.
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      // fences
      if (!plainStart && (token = this.tokenizer.fences(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // heading
      if (!plainStart && (token = this.tokenizer.heading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // hr
      if (!plainStart && (token = this.tokenizer.hr(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // blockquote
      if (!plainStart && (token = this.tokenizer.blockquote(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // list
      if (!plainStart && (token = this.tokenizer.list(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // html
      if (!plainStart && (token = this.tokenizer.html(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // def
      if (!plainStart && (token = this.tokenizer.def(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          // The first definition of a label wins, but a later one still consumes its text.
          if (!this.tokens.links[token.tag]) {
            this.tokens.links[token.tag] = {
              href: token.href,
              title: token.title,
            };
          }
          tokens.push(token);
        }
        continue;
      }

      // table (gfm)
      if (token = this.tokenizer.table(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // lheading
      if (token = this.tokenizer.lheading(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // top-level paragraph
      if (this.state.top && (token = this.tokenizer.paragraph(src))) {
        const lastToken = tokens.at(-1);
        if (lastParagraphClipped && lastToken?.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        lastParagraphClipped = false;
        src = src.substring(token.raw.length);
        continue;
      }

      // text
      if (token = this.tokenizer.text(src)) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (src) {
        throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      }
    }

    this.state.top = true;
    return tokens;
  }

  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  // Does this link text hold a link already? An image does not count: an image
  // may hold a link, a link may not.
  linkInText(text) {
    if (!text.includes('[')) {
      return false;
    }

    const linkRule = inlineRules.link;
    for (const match of text.matchAll(inlineRules.blockSkip)) {
      // blockSkip also matches code spans and html, and the `!` of an image is
      // left out of the match, so read the character before it.
      if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
        return true;
      }
    }

    for (const match of text.matchAll(inlineRules.reflinkSearch)) {
      const match0 = match[0];
      const refStart = match0.lastIndexOf('[');
      if (match0.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        continue;
      }
      // A candidate holding a link is not a link either, so it does not count.
      if (refStart > 1 && this.linkInText(match0.slice(1, refStart - 1))) {
        continue;
      }
      return true;
    }

    return false;
  }

  inlineTokens(src, tokens = []) {
    this.tokenizer.lexer = this;
    // One paren scan per inline run, shared with Tokenizer.link: without a
    // ')' ahead the link regex cannot match, and skipping it avoids its
    // quadratic backtracking over unterminated-link inputs like
    // `'[a](b'.repeat(n)`. A nested run receives a substring of the outer
    // run, so if the outer had no ')' neither does this substring — skip
    // the scan in that case.
    const prevLinkParenPossible = this.state.linkParenPossible;
    this.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
    try {
      return this.inlineTokensInner(src, tokens);
    } finally {
      // A nested run (e.g. a link label) anchored on its own substring;
      // restore the outer run's flag for the rest of its loop.
      this.state.linkParenPossible = prevLinkParenPossible;
    }
  }

  inlineTokensInner(src, tokens) {
    // The masked source is only read by emStrong and del, which need a *, _ or
    // ~ to start. Skip building it for a run without one.
    const maskedSrc = src.includes('*') || src.includes('_') || src.includes('~')
      ? this.maskSrc(src)
      : src;

    // One scan of this maskedSrc for the last emphasis, strong, and
    // strikethrough closers, shared by every opener in the pass. Popped
    // when the pass ends so the source is not retained.
    beginCloserScan(this.tokenizer, maskedSrc);
    try {
      return this.tokenizeInlines(src, maskedSrc, tokens);
    } finally {
      endCloserScan(this.tokenizer);
    }
  }

  tokenizeInlines(src, maskedSrc, tokens) {
    let keepPrevChar = false;
    let prevChar = '';
    let srcLength = Infinity;
    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      }

      if (!keepPrevChar) {
        prevChar = '';
      }
      keepPrevChar = false;

      let token;

      // Dispatch on the first character (see inlineBucket): every inline
      // tokenizer except `text` is anchored to a specific starting character,
      // so tokenizers that cannot match here are never run. Order within a
      // bucket follows marked's: escape, tag, link, reflink, emStrong,
      // codespan, br, del, autolink, url, text. `url` may also start at `_`
      // (an email address), so it is tried there after emStrong.
      const c0 = src.charCodeAt(0);
      const bucket = c0 < 128 ? inlineBucket[c0] : 7;
      if (bucket === 0) { // backslash: escape, br
        if (token = this.tokenizer.escape(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.br(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (bucket === 1) { // <: tag, autolink
        if (token = this.tokenizer.tag(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.autolink(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (bucket === 2) { // [ or !: link, reflink
        if (token = this.tokenizer.link(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.reflink(src, this.tokens.links)) {
          src = src.substring(token.raw.length);
          const lastToken = tokens.at(-1);
          if (token.type === 'text' && lastToken?.type === 'text') {
            lastToken.raw += token.raw;
            lastToken.text += token.text;
          } else {
            tokens.push(token);
          }
          continue;
        }
      } else if (bucket === 3) { // * or _: emStrong, then url at _
        if (token = this.tokenizer.emStrong(src, maskedSrc, prevChar)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (c0 === 95 && !this.state.inLink && (token = this.tokenizer.url(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (bucket === 4) { // backtick: codespan
        if (token = this.tokenizer.codespan(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (bucket === 5) { // ~: del
        if (token = this.tokenizer.del(src, maskedSrc, prevChar)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (bucket === 6) { // space: br
        if (token = this.tokenizer.br(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (!this.state.inLink // anything else: url, then text
        && (c0 === 46 || c0 === 43 || c0 === 45
          || (c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))
        && (token = this.tokenizer.url(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // text
      if (token = this.tokenizer.inlineText(src)) {
        src = src.substring(token.raw.length);
        if (token.raw.slice(-1) !== '_') { // Track prevChar before string of ____ started.
          prevChar = token.raw.slice(-1);
        }
        keepPrevChar = true;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (src) {
        throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      }
    }

    return tokens;
  }

  // Mask links, code, html and escapes so emStrong and del do not see their
  // delimiters inside them.
  maskSrc(src) {
    // String with links masked to avoid interference with em and strong.
    let maskedSrc = src;

    // Mask out reflinks.
    if (this.tokens.links && src.includes('[')) {
      const reflinkSearch = inlineRules.reflinkSearch;
      const maskReflink = (match0) => {
        const refStart = match0.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
          return match0;
        }
        // CommonMark: "Links may not contain other links, at any level of
        // nesting." A candidate whose text already holds one never becomes a
        // link, so flattening the whole span would hide the emphasis that
        // does still apply inside it. Mask the links it holds instead.
        // Images are exempt: their text is flattened into an alt attribute.
        if (refStart > 1 && match0.charAt(0) !== '!') {
          const text = match0.slice(1, refStart - 1);
          if (this.linkInText(text)) {
            return '[' + text.replace(reflinkSearch, maskReflink)
              + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match0.length - 2) + ']';
      };
      maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
    }

    // Mask out escaped characters.
    // Every mask must keep the length it replaces: emStrong and del line
    // maskedSrc up with src by slicing from the end. `anyPunctuation` matches
    // unicode punctuation, so an escaped astral character is 3 code units.
    // A backslash inside a code span is literal, not an escape. Mask the
    // backticks inside the span instead, so blockSkip still skips all of it.
    // The pattern can only match where a backtick or a backslash sits.
    if (maskedSrc.includes('`') || maskedSrc.includes('\\')) {
      maskedSrc = maskedSrc.replace(inlineRules.anyPunctuationOutsideCode, (match0, code, punct) => {
        if (punct) {
          return '+'.repeat(match0.length);
        }
        if (code) {
          return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
        }
        return match0;
      });
    }

    // Mask out other blocks. blockSkip can only match a link (needs `[`),
    // a code span (needs a backtick) or html (needs `<`).
    if (maskedSrc.includes('[') || maskedSrc.includes('`') || maskedSrc.includes('<')) {
      maskedSrc = maskedSrc.replace(inlineRules.blockSkip, (match0, _link, context) => {
        const offset = context ? context.length : 0;
        return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
      });
    }

    return maskedSrc;
  }
}

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

class Renderer {
  constructor() {
    this.parser = null; // wired by the Parser
  }

  space() {
    return '';
  }

  code({ text, lang, escaped }) {
    const langString = (lang || '').match(misc.notSpaceStart)?.[0];

    // An empty code block has no content, so it must not gain a newline.
    const code = text ? text.replace(misc.endingNewline, '') + '\n' : '';

    if (!langString) {
      return '<pre><code>'
        + (escaped ? code : escapeHtmlEntities(code, true))
        + '</code></pre>\n';
    }

    return '<pre><code class="language-'
      + escapeHtmlEntities(langString)
      + '">'
      + (escaped ? code : escapeHtmlEntities(code, true))
      + '</code></pre>\n';
  }

  blockquote({ tokens }) {
    const body = this.parser.parse(tokens);
    return `<blockquote>\n${body}</blockquote>\n`;
  }

  html({ text }) {
    return text;
  }

  def() {
    return '';
  }

  heading({ tokens, depth }) {
    return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
  }

  hr() {
    return '<hr>\n';
  }

  list(token) {
    const ordered = token.ordered;
    const start = token.start;

    let body = '';
    for (let j = 0; j < token.items.length; j++) {
      const item = token.items[j];
      body += this.listitem(item);
    }

    const type = ordered ? 'ol' : 'ul';
    const startAttr = (ordered && start !== 1) ? (' start="' + start + '"') : '';
    return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
  }

  listitem(item) {
    return `<li>${this.parser.parse(item.tokens)}</li>\n`;
  }

  checkbox({ checked }) {
    return '<input '
      + (checked ? 'checked="" ' : '')
      + 'disabled="" type="checkbox"> ';
  }

  paragraph({ tokens }) {
    return `<p>${this.parser.parseInline(tokens)}</p>\n`;
  }

  table(token) {
    let header = '';

    // header
    let cell = '';
    for (let j = 0; j < token.header.length; j++) {
      cell += this.tablecell(token.header[j]);
    }
    header += this.tablerow({ text: cell });

    let body = '';
    for (let j = 0; j < token.rows.length; j++) {
      const row = token.rows[j];

      cell = '';
      for (let k = 0; k < row.length; k++) {
        cell += this.tablecell(row[k]);
      }

      body += this.tablerow({ text: cell });
    }
    if (body) body = `<tbody>${body}</tbody>`;

    return '<table>\n'
      + '<thead>\n'
      + header
      + '</thead>\n'
      + body
      + '</table>\n';
  }

  tablerow({ text }) {
    return `<tr>\n${text}</tr>\n`;
  }

  tablecell(token) {
    const content = this.parser.parseInline(token.tokens);
    const type = token.header ? 'th' : 'td';
    const tag = token.align
      ? `<${type} align="${token.align}">`
      : `<${type}>`;
    return tag + content + `</${type}>\n`;
  }

  // span level renderer
  strong({ tokens }) {
    return `<strong>${this.parser.parseInline(tokens)}</strong>`;
  }

  em({ tokens }) {
    return `<em>${this.parser.parseInline(tokens)}</em>`;
  }

  codespan({ text }) {
    return `<code>${escapeHtmlEntities(text, true)}</code>`;
  }

  br() {
    return '<br>';
  }

  del({ tokens }) {
    return `<del>${this.parser.parseInline(tokens)}</del>`;
  }

  link({ href, title, text, tokens, autolink }) {
    // References are not resolved inside an autolink, so every `&` there is
    // literal. Elsewhere only an `&` that cannot start one needs escaping.
    const parsedText = autolink
      ? escapeHtmlEntities(text, true)
      : this.parser.parseInline(tokens);
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return parsedText;
    }
    href = escapeHtmlEntities(cleanHref, autolink);
    let out = '<a href="' + href + '"';
    if (title) {
      out += ' title="' + (escapeHtmlEntities(title)) + '"';
    }
    out += '>' + parsedText + '</a>';
    return out;
  }

  image({ href, title, text, tokens }) {
    if (tokens) {
      text = this.parser.parseInline(tokens, this.parser.textRenderer);
    }
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return escapeHtmlEntities(text);
    }
    href = cleanHref;

    let out = `<img src="${escapeHtmlEntities(href)}" alt="${escapeHtmlEntities(text)}"`;
    if (title) {
      out += ` title="${escapeHtmlEntities(title)}"`;
    }
    out += '>';
    return out;
  }

  text(token) {
    return 'tokens' in token && token.tokens
      ? this.parser.parseInline(token.tokens)
      : ('escaped' in token && token.escaped ? token.text : escapeHtmlEntities(token.text));
  }
}

// TextRenderer: returns only the textual part of a token (used for image alt text).
class TextRenderer {
  constructor() {
    this.parser = null; // wired by the Parser
  }

  strong({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  em({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  codespan({ text }) {
    return text;
  }

  del({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  html({ text }) {
    return text;
  }

  text({ text }) {
    return text;
  }

  link({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  image({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  br() {
    return '';
  }

  checkbox({ raw }) {
    return raw;
  }
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    let out = '';

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      switch (token.type) {
        case 'space': {
          out += this.renderer.space(token);
          break;
        }
        case 'hr': {
          out += this.renderer.hr(token);
          break;
        }
        case 'heading': {
          out += this.renderer.heading(token);
          break;
        }
        case 'code': {
          out += this.renderer.code(token);
          break;
        }
        case 'table': {
          out += this.renderer.table(token);
          break;
        }
        case 'blockquote': {
          out += this.renderer.blockquote(token);
          break;
        }
        case 'list': {
          out += this.renderer.list(token);
          break;
        }
        case 'checkbox': {
          out += this.renderer.checkbox(token);
          break;
        }
        case 'html': {
          out += this.renderer.html(token);
          break;
        }
        case 'def': {
          out += this.renderer.def(token);
          break;
        }
        case 'paragraph': {
          out += this.renderer.paragraph(token);
          break;
        }
        case 'text': {
          out += this.renderer.text(token);
          break;
        }

        default: {
          throw new Error('Token with "' + token.type + '" type was not found.');
        }
      }
    }

    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    let out = '';

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      switch (token.type) {
        case 'escape': {
          out += renderer.text(token);
          break;
        }
        case 'html': {
          out += renderer.html(token);
          break;
        }
        case 'link': {
          out += renderer.link(token);
          break;
        }
        case 'image': {
          out += renderer.image(token);
          break;
        }
        case 'checkbox': {
          out += renderer.checkbox(token);
          break;
        }
        case 'strong': {
          out += renderer.strong(token);
          break;
        }
        case 'em': {
          out += renderer.em(token);
          break;
        }
        case 'codespan': {
          out += renderer.codespan(token);
          break;
        }
        case 'br': {
          out += renderer.br(token);
          break;
        }
        case 'del': {
          out += renderer.del(token);
          break;
        }
        case 'text': {
          out += renderer.text(token);
          break;
        }
        default: {
          throw new Error('Token with "' + token.type + '" type was not found.');
        }
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

// Render `markdown` exactly as marked 18.1.3 does with its default options.
// Fresh Lexer and Parser per call: no state survives between calls, and the
// only module-level shared values are immutable regexes and tables.
export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return new Parser().parse(tokens);
}
