// The client sites whose forms post here. One entry per site:
//
//   name      how the site is named in the email (the desk's name for it)
//   live      the hostnames of the live site. A form sent from one of these
//             goes to `to`, the client.
//   staging   the hostnames of the staging copy. A form sent from one of
//             these goes to STAGING_TO instead, so a test on staging never
//             reaches the client.
//   to        the client's own address: the main email on the desk
//   sitekey   the site's Turnstile widget (public). Its secret is the Worker
//             secret TURNSTILE_SECRET_<KEY>, where <KEY> is the site's key in
//             upper case: `npx wrangler secret put TURNSTILE_SECRET_AEROSPOT
//             -c forms/wrangler.jsonc`.
//
// A request from any other hostname is refused, and so is a Turnstile token
// issued on any other hostname. Each widget allows exactly these hostnames,
// so a new hostname is added in both places: here, and on the widget in the
// Cloudflare dashboard (Turnstile).

export const SITES = {
  aerospot: {
    name: 'Aerospot Airport Parking',
    live: ['aerospot.ca', 'www.aerospot.ca'],
    staging: ['stage-site-production-8e21.up.railway.app'],
    to: ['info@aerospot.ca'],
    sitekey: '0x4AAAAAAF3svlHrMmUGnIcZ',
  },
  beconstructionltd: {
    name: 'B.E. Construction Ltd',
    live: ['beconstructionltd.com', 'www.beconstructionltd.com'],
    staging: ['stage-site-production-eec3.up.railway.app'],
    to: ['info@beconstructionltd.com'],
    sitekey: '0x4AAAAAAF3svx5RXwv-pJWj',
  },
  comtradsourcing: {
    name: 'Comtrad Strategic Sourcing',
    live: ['comtradsourcing.com', 'www.comtradsourcing.com'],
    staging: ['stage-site-production-73e0.up.railway.app'],
    to: ['inquiries@comtradsourcing.com'],
    sitekey: '0x4AAAAAAF3sxQCYEi5pUxd7',
  },
  designtosuit: {
    name: 'Design To Suit Inc.',
    live: ['designtosuit.ca', 'www.designtosuit.ca'],
    staging: ['stage-site-production-b75a.up.railway.app'],
    to: ['info@designtosuit.ca'],
    sitekey: '0x4AAAAAAF3swCmb7abU2ZjN',
  },
  hazelgreen: {
    name: 'Hazel Green Cleaning Services',
    live: ['hazelgreencleaners.ca', 'www.hazelgreencleaners.ca'],
    staging: ['stage-site-production-58e0.up.railway.app'],
    to: ['info@hazelgreencleaners.ca'],
    sitekey: '0x4AAAAAAF3swXzgXX1rUB2C',
  },
  powervactoronto: {
    name: 'Power Vac Toronto',
    live: ['powervactoronto.ca', 'www.powervactoronto.ca'],
    staging: ['stage-powervactoronto.ash-47a.workers.dev'],
    to: ['info@powervac-toronto.com'],
    sitekey: '0x4AAAAAAF3sw6Ov_BjPuYWx',
  },
  trerosebakery: {
    name: 'TreRose Bakery',
    live: ['trerosebakery.ca', 'www.trerosebakery.ca'],
    staging: ['stage-site-production-fff0.up.railway.app'],
    to: ['trerosebakery@hotmail.com'],
    sitekey: '0x4AAAAAAF3sxORQ4SkAft7J',
  },
};

// The Worker secret that holds a site's Turnstile secret key.
export const secretName = (key) => `TURNSTILE_SECRET_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
