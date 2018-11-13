//https://www.digitalocean.com/community/questions/nginx-ssl-multiple-domains
doc = `
Usage:
  motesque-balena-dnsimple update --balena_auth_token=<token> --dnsimple_auth_token=<token> --account_id=<account_id> --zone=<zone> [--sandbox]
  motesque-balena-dnsimple clear  --balena_auth_token=<token> --dnsimple_auth_token=<token> --account_id=<account_id> --zone=<zone> [--sandbox]
  motesque-balena-dnsimple -h | --help | --version
`;
const {docopt} = require('docopt');

const cmdLineArgs = docopt(doc, {
  version: '0.0.1'
});

//console.log(cmdLineArgs);

let balena = require('balena-sdk')({debug: false});
let path = require('path');
let __fileName = path.basename(__filename);

var dnsimple = require("dnsimple")({
    baseUrl: cmdLineArgs['--sandbox'] ?  'https://api.sandbox.dnsimple.com' : 'https://api.dnsimple.com',
    accessToken: cmdLineArgs['--dnsimple_auth_token'],
  });

// dnsimple.identity.whoami().then(function(response) {
//   console.log(response.data);
// }, function(error) {
//   console.log(error);
// });


async function loginBalena(authToken) {
  try {
    let res = await balena.auth.loginWithToken(authToken);
    return await balena.auth.isLoggedIn();
  }
  catch (err) {
    console.error(err);
    return false;
  }
}


async function gatherBalenaDeviceIps() {
    let deviceIpsMap = {};
    let res = await balena.models.device.getAll();
    for (let d of res) {
      let ips = d.ip_address.split(' ');
      deviceIpsMap[d.uuid.substring(0,7)] = new Set(ips);
    }
    return deviceIpsMap;
}

async function gatherDnsEntries(accountId, zoneId) {
   let dnsMap = {};
   // query number of pages first
   let res = await dnsimple.zones.listZoneRecords(accountId, zoneId, {page: 1});
   for (let p = 1; p <= res.pagination.total_pages; p++) {
       res = await dnsimple.zones.listZoneRecords(accountId, zoneId, {page: p});
       let records = res.data.filter((z) => { return z.type === 'A' && z.name.length === 7 });
       for (let r of records) {
          if (dnsMap[r.name] === undefined) {
             dnsMap[r.name] = [{ip: r.content, id:r.id}];
          }
          else {
             dnsMap[r.name].push({ip: r.content, id:r.id});
          }
       }
   }
   return dnsMap;
}

function difference(setA, setB) {
    let _difference = new Set(setA);
    for (let elem of setB) {
        _difference.delete(elem);
    }
    return _difference;
}


function matchDns(deviceIpsMap, dnsMap) {
  let missing =  [];
  let obsolete = [];
  let existing = [];
  for (let [uuid, deviceIps] of Object.entries(deviceIpsMap)) {
      let dnsIps = new Set([]);
      if (dnsMap[uuid] !== undefined) {
          dnsIps = new Set(dnsMap[uuid].map((content) => {
                    return content.ip;
          }));
      }
      const dnsIpMissing  = difference(deviceIps,dnsIps); // (A, B) - A = B
      const dnsIpObsolete = difference(dnsIps, deviceIps); // (B) - A = B
      for (let ip of dnsIpMissing) {
        missing.push({name: uuid, ip: ip});
      }
      for (let ip of dnsIpObsolete) {
        obsolete.push({name: uuid, ip: ip, id: dnsMap[uuid].filter((content) => { return content.ip === ip })[0].id });
      }
      for (let ip of dnsIps) {
        existing.push({name: uuid, ip: ip, id: dnsMap[uuid].filter((content) => { return content.ip === ip })[0].id });
      }
  }
  return {"missing": missing, "obsolete": obsolete, "existing": existing};
}


async function removeRecords(accountId, zoneId, records) {
  let removed = 0;
  for (let rec of records) {
     try {
       await dnsimple.zones.deleteZoneRecord(accountId, zoneId, rec.id);
       log_info(`action="removed dns record", zone="${zoneId}", name=${rec.name}, ip="${rec.ip}", id=${rec.id}`);
       removed++;
     }
     catch (e) {
       log_error(`error="cannon remove dns record", zone="${zoneId}", name="${rec.name}", ip="${rec.ip}", id=${rec.id} reason="${JSON.stringify(e)}"`)
     }
  }
  return removed;
}


async function addRecords(accountId, zoneId, records) {
  let added = 0;
  for (let rec of records) {
     try {
       await dnsimple.zones.createZoneRecord(accountId, zoneId, {name: rec.name, type: 'A', ttl: 303, content: rec.ip});
       log_info(`action="added dns record", zone="${zoneId}", name="${rec.name}", ip="${rec.ip}"`);
       added++;
     }
     catch (e) {
       log_error(`error="cannon add dns record", zone="${zoneId}", name="${rec.name}", ip="${rec.ip}", reason="${JSON.stringify(e)}"`)
     }

  }
  return added;
}

function log_info(msg) {
  log_type("INFO", msg);
}

function log_error(msg) {
    log_type("ERROR", msg);
}


function log_type(type, msg) {
  // simple mechanism to mimic python style logging
  const _date  = new Date().toISOString().replace(/T/, ' ').replace(/\./, ',').replace(/Z/, '');
  const _time  = "";
  console.log(`${_date} ${_time}${type} file="${__fileName}:0" ${msg}\r\n`)
}
async function main() {

  const accountId = parseInt(cmdLineArgs["--account_id"], 10);
  const zoneId = cmdLineArgs["--zone"];
  if (!await loginBalena(cmdLineArgs["--balena_auth_token"])) {
      throw "login to balena failed. Check auth token!";
  }
  log_info(`action="fetching current dns records" zone="${zoneId}"`);
  let dnsMap = await gatherDnsEntries(accountId, zoneId);
  log_info(`action="fetching current balena device info"`);
  let deviceIpsMap = await gatherBalenaDeviceIps();
  let res = matchDns(deviceIpsMap, dnsMap);
  if (cmdLineArgs["update"]) {
     const removed = await removeRecords(accountId, zoneId, res.obsolete);
     const added  = await addRecords(accountId, zoneId, res.missing);
     log_info(`status="dns records updated", zone="${zoneId}", added=${added}, removed=${removed}`);
  }
  else if (cmdLineArgs["clear"]) {
    const removed = await removeRecords(accountId, zoneId, res.existing);
    log_info(`status="dns records cleared", zone="${zoneId}", removed=${removed}`);
  }

}



module.exports = () => {
  main().catch(err => {
    log_error(JSON.stringify(err));
  });
};
