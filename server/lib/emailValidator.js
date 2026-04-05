import { promises as dns } from "dns";

// ── Disposable / temp mail domain blocklist ───────────────────────────────────
const BLOCKED_DOMAINS = new Set([
  // Major temp mail services
  "mailinator.com","guerrillamail.com","guerrillamail.net","guerrillamail.org",
  "guerrillamail.biz","guerrillamail.de","guerrillamail.info","grr.la",
  "sharklasers.com","guerrillamailblock.com","spam4.me","trashmail.com",
  "trashmail.me","trashmail.net","trashmail.at","trashmail.io","trashmail.org",
  "trashmail.xyz","tempmail.com","tempmail.net","tempmail.org","temp-mail.org",
  "temp-mail.io","temp-mail.ru","dispostable.com","mailnull.com","spamgourmet.com",
  "spamgourmet.net","spamgourmet.org","yopmail.com","yopmail.fr","cool.fr.nf",
  "jetable.fr.nf","nospam.ze.tc","nomail.xl.cx","mega.zik.dj","speed.1s.fr",
  "courriel.fr.nf","moncourrier.fr.nf","monemail.fr.nf","monmail.fr.nf",
  "throwam.com","throwam.net","throwam.org","mailnesia.com","mailnull.com",
  "spamfree24.org","spamfree24.de","spamfree24.eu","spamfree24.info",
  "spamfree24.net","spamfree24.com","spamfree.eu","spam.la","spamoff.de",
  "spamspot.com","spamthis.co.uk","spamtroll.net","discard.email",
  "discardmail.com","discardmail.de","spamgob.com","fakeinbox.com",
  "fakeinbox.net","fakeinbox.org","mailexpire.com","mailexpire.net",
  "mailexpire.org","mailnew.com","mailnew.net","mailnew.org","mailnew.info",
  "10minutemail.com","10minutemail.net","10minutemail.org","10minutemail.co.uk",
  "10minutemail.de","10minutemail.ru","10minutemail.be","10minutemail.cf",
  "10minutemail.ga","10minutemail.gq","10minutemail.ml","10minutemail.tk",
  "20minutemail.com","20minutemail.it","20minutemail.net","20minutemail.org",
  "minutemail.com","minutemail.net","minutemail.org","minutemail.de",
  "33mail.com","filzmail.com","filzmail.de","filzmail.net","filzmail.org",
  "getairmail.com","getairmail.cf","getairmail.ga","getairmail.gq",
  "getairmail.ml","getairmail.tk","maildrop.cc","maildrop.cf","maildrop.ga",
  "maildrop.gq","maildrop.ml","maildrop.tk","mailnull.com","mailnull.net",
  "mailnull.org","mailnull.de","mailnull.info","mailnull.biz","mailnull.us",
  "throwaway.email","throwaway.net","throwaway.org","throwaway.de",
  "throwaway.info","throwaway.biz","throwaway.us","throwaway.co",
  "spamgob.com","spamgob.net","spamgob.org","spamgob.de","spamgob.info",
  "spamgob.biz","spamgob.us","spamgob.co","spamgob.io","spamgob.me",
  "getnada.com","getnada.net","getnada.org","getnada.de","getnada.info",
  "mohmal.com","mohmal.net","mohmal.org","mohmal.de","mohmal.info",
  "mohmal.biz","mohmal.us","mohmal.co","mohmal.io","mohmal.me",
  "tempinbox.com","tempinbox.net","tempinbox.org","tempinbox.de",
  "tempinbox.info","tempinbox.biz","tempinbox.us","tempinbox.co",
  "inboxbear.com","inboxbear.net","inboxbear.org","inboxbear.de",
  "sharklasers.com","guerrillamail.info","grr.la","guerrillamail.biz",
  "spam4.me","trashmail.at","trashmail.me","trashmail.io","trashmail.xyz",
  "mailnull.com","spamgourmet.com","yopmail.com","yopmail.fr",
  "dispostable.com","mailnesia.com","spamfree24.org","discard.email",
  "fakeinbox.com","mailexpire.com","10minutemail.com","20minutemail.com",
  "33mail.com","filzmail.com","getairmail.com","maildrop.cc","throwaway.email",
  "getnada.com","mohmal.com","tempinbox.com","inboxbear.com",
  "mailinator.net","mailinator.org","mailinator.info","mailinator.biz",
  "mailinator.us","mailinator.co","mailinator.io","mailinator.me",
  "guerrillamail.com","guerrillamail.net","guerrillamail.org",
  "guerrillamail.biz","guerrillamail.de","guerrillamail.info",
  "spamgourmet.net","spamgourmet.org","trashmail.net","trashmail.org",
  "tempmail.com","tempmail.net","tempmail.org","temp-mail.org","temp-mail.io",
  "mailnull.net","mailnull.org","mailnull.de","mailnull.info","mailnull.biz",
  "spamfree24.de","spamfree24.eu","spamfree24.info","spamfree24.net",
  "spamfree.eu","spam.la","spamoff.de","spamspot.com","spamthis.co.uk",
  "spamtroll.net","discardmail.com","discardmail.de","spamgob.com",
  "fakeinbox.net","fakeinbox.org","mailexpire.net","mailexpire.org",
  "mailnew.com","mailnew.net","mailnew.org","mailnew.info",
  "10minutemail.net","10minutemail.org","10minutemail.co.uk","10minutemail.de",
  "10minutemail.ru","10minutemail.be","10minutemail.cf","10minutemail.ga",
  "10minutemail.gq","10minutemail.ml","10minutemail.tk",
  "20minutemail.it","20minutemail.net","20minutemail.org",
  "minutemail.com","minutemail.net","minutemail.org","minutemail.de",
  "filzmail.de","filzmail.net","filzmail.org",
  "getairmail.cf","getairmail.ga","getairmail.gq","getairmail.ml","getairmail.tk",
  "maildrop.cf","maildrop.ga","maildrop.gq","maildrop.ml","maildrop.tk",
  "throwaway.net","throwaway.org","throwaway.de","throwaway.info",
  "throwaway.biz","throwaway.us","throwaway.co",
  "getnada.net","getnada.org","getnada.de","getnada.info",
  "mohmal.net","mohmal.org","mohmal.de","mohmal.info","mohmal.biz",
  "mohmal.us","mohmal.co","mohmal.io","mohmal.me",
  "tempinbox.net","tempinbox.org","tempinbox.de","tempinbox.info",
  "tempinbox.biz","tempinbox.us","tempinbox.co",
  "inboxbear.net","inboxbear.org","inboxbear.de",
  // Additional known disposable services
  "mailsac.com","mailsac.net","mailsac.org","mailsac.de",
  "spamgob.net","spamgob.org","spamgob.de","spamgob.info","spamgob.biz",
  "spamgob.us","spamgob.co","spamgob.io","spamgob.me",
  "nwytg.com","nwytg.net","nwytg.org","nwytg.de",
  "cuvox.de","dayrep.com","einrot.com","fleckens.hu","gustr.com",
  "jourrapide.com","rhyta.com","superrito.com","teleworm.us","armyspy.com",
  "cuvox.de","dayrep.com","einrot.com","fleckens.hu","gustr.com",
  "jourrapide.com","rhyta.com","superrito.com","teleworm.us","armyspy.com",
  "tempr.email","tempr.net","tempr.org","tempr.de","tempr.info",
  "dispostable.com","dispostable.net","dispostable.org","dispostable.de",
  "spamgob.com","spamgob.net","spamgob.org","spamgob.de","spamgob.info",
  "mailnull.com","mailnull.net","mailnull.org","mailnull.de","mailnull.info",
  "spamfree24.org","spamfree24.de","spamfree24.eu","spamfree24.info",
  "spamfree24.net","spamfree24.com","spamfree.eu","spam.la","spamoff.de",
  "yopmail.net","yopmail.org","yopmail.de","yopmail.info","yopmail.biz",
  "yopmail.us","yopmail.co","yopmail.io","yopmail.me",
  "trashmail.com","trashmail.me","trashmail.net","trashmail.at",
  "trashmail.io","trashmail.org","trashmail.xyz",
  "guerrillamail.com","guerrillamail.net","guerrillamail.org",
  "guerrillamail.biz","guerrillamail.de","guerrillamail.info",
  "sharklasers.com","grr.la","guerrillamailblock.com","spam4.me",
  "mailinator.com","mailinator.net","mailinator.org","mailinator.info",
  "mailinator.biz","mailinator.us","mailinator.co","mailinator.io",
  "mailinator.me","mailinator.de","mailinator.fr","mailinator.es",
  "mailinator.it","mailinator.nl","mailinator.pl","mailinator.ru",
  "mailinator.cn","mailinator.jp","mailinator.kr","mailinator.br",
  "mailinator.in","mailinator.au","mailinator.ca","mailinator.mx",
  "mailinator.ar","mailinator.cl","mailinator.co","mailinator.pe",
  "mailinator.ve","mailinator.ec","mailinator.bo","mailinator.py",
  "mailinator.uy","mailinator.gt","mailinator.hn","mailinator.sv",
  "mailinator.ni","mailinator.cr","mailinator.pa","mailinator.cu",
  "mailinator.do","mailinator.pr","mailinator.jm","mailinator.tt",
  "mailinator.bb","mailinator.lc","mailinator.vc","mailinator.gd",
  "mailinator.ag","mailinator.dm","mailinator.kn","mailinator.ms",
  "mailinator.ai","mailinator.vg","mailinator.vi","mailinator.ky",
  "mailinator.tc","mailinator.bm","mailinator.bs","mailinator.aw",
  "mailinator.cw","mailinator.sx","mailinator.mq","mailinator.gp",
  "mailinator.gf","mailinator.sr","mailinator.gy","mailinator.fk",
  "mailinator.gs","mailinator.sh","mailinator.ac","mailinator.io",
  "mailinator.tf","mailinator.re","mailinator.yt","mailinator.pm",
  "mailinator.wf","mailinator.nc","mailinator.pf","mailinator.ck",
  "mailinator.nu","mailinator.tk","mailinator.to","mailinator.ws",
  "mailinator.ki","mailinator.tv","mailinator.nr","mailinator.pw",
  "mailinator.fm","mailinator.mh","mailinator.mp","mailinator.gu",
  "mailinator.as","mailinator.um","mailinator.vi",
]);

// ── Format check ──────────────────────────────────────────────────────────────
function isValidFormat(email) {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email);
}

// ── Well-known legitimate domains — skip MX check ────────────────────────────
const TRUSTED_DOMAINS = new Set([
  "gmail.com","yahoo.com","yahoo.in","yahoo.co.in","outlook.com","hotmail.com",
  "live.com","icloud.com","me.com","mac.com","protonmail.com","proton.me",
  "zoho.com","aol.com","msn.com","rediffmail.com","yandex.com","yandex.ru",
  "tutanota.com","fastmail.com","hey.com","pm.me",
]);

// ── Suspicious local-part check (random-looking strings) ─────────────────────
function isSuspiciousLocalPart(local) {
  const letters = local.toLowerCase().replace(/[^a-z]/g, "");
  if (letters.length < 6) return false;

  // Too many consecutive consonants (e.g. "kdjfgdjhfg", "fgsgdfvjhdves")
  const consonantRun = /[bcdfghjklmnpqrstvwxyz]{5,}/i.test(letters);

  // No vowels at all in a long string
  const noVowels = letters.length >= 6 && !/[aeiou]/.test(letters);

  // High entropy only if ALSO no vowels or consonant run — avoid false positives
  const unique = new Set(letters).size;
  const highEntropy = letters.length >= 9 && (unique / letters.length) > 0.85 && noVowels;

  return consonantRun || noVowels || highEntropy;
}

// ── MX record check ───────────────────────────────────────────────────────────
async function hasMXRecord(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records && records.length > 0;
  } catch {
    return false;
  }
}

// ── Main validator ────────────────────────────────────────────────────────────
export async function validateEmail(email) {
  if (!email || typeof email !== "string") {
    return { valid: false, reason: "Email is required." };
  }

  const trimmed = email.trim().toLowerCase();

  if (!isValidFormat(trimmed)) {
    return { valid: false, reason: "Please enter a valid email address." };
  }

  const [local, domain] = trimmed.split("@");

  if (BLOCKED_DOMAINS.has(domain)) {
    return { valid: false, reason: "Disposable or temporary email addresses are not allowed. Please use a real email." };
  }

  if (isSuspiciousLocalPart(local)) {
    return { valid: false, reason: "This email address doesn't look real. Please use your actual email." };
  }

  // Skip MX check for well-known providers
  if (!TRUSTED_DOMAINS.has(domain)) {
    const hasMX = await hasMXRecord(domain);
    if (!hasMX) {
      return { valid: false, reason: "This email domain doesn't appear to exist. Please check your email address." };
    }
  }

  return { valid: true, reason: "" };
}
