function splitExceptQuotes(string,delimiter,escapeOpen=true) {
    var result = [];
    var pq = false;
    var cv = '';
    const quote = (string,pos) => (string[pos] === '"' && (!escapeOpen || (string[pos-1] !== '\\' || (string[pos-1] === '\\' && string[pos-2] === '\\'))))
    for(var pos=0;pos<string.length;pos++) {
        if(pq) {
            if(quote(string,pos)) {
                pq = false;
            }
            cv += string[pos];
            continue;
        }
        if(quote(string,pos)) {
            pq = true;
        } else if(string[pos] === delimiter) {
            result.push(cv);
            cv = '';
            continue
        };

        cv += string[pos];
    }

    result.push(cv);

    return result;
}

function escapeQuotes(string) {
    return string.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
}

function unescapeQuotes(string) {
    return string.replace(/([^\\]|^)\\"/g,'$1"').replace(/\\\\/g,'\\');
}

// Extracts address fields into name/address parts.
// No it's not perfect. Yes it's good enough. Probably.
async function extractAddresses(addresses) {
    if(typeof addresses === 'string') {
        addresses = [addresses]
    }

    const parsed = [];

    for(const ai of addresses.filter(Boolean)) {
        var pa = false; // Is parsing address
        var pm = false; // Has seen list name
        var pq = false // Is parsing quote
        var pci = 0; // Current comment level
        var cn = ''; // Current name
        var ca = ''; // Current address

        for(var pos=0;pos<ai.length;pos++) {
            if(ai[pos] === '\r' || ai[pos] === '\n')
                continue; // anything else and you're on your own
            if(pa) {
                if(ai[pos] === ';') {
                    continue;
                }
                if(ai[pos] === ',') {
                    pa=false;
                    parsed.push([cn,ca]);
                    cn = '';
                    ca = '';
                    continue;
                }
                if(ai[pos] === '>') {
                    // End parsing address
                    pa=false;
                    parsed.push([cn,ca]);
                    cn = '';
                    ca = '';
                    continue;
                }
                ca += ai[pos];
                continue;
            }
            // no pa
            if(pq) {
                if(ai[pos] === '"' && ai[pos-1] !== '\\') {
                    pq = false;
                    continue;
                }
            } else { // no pq
                if(ai[pos] === '(' && ai[pos-1] !== '\\(') {
                    // Increment pci
                    pci++;
                    continue;
                }
                if(pci) {
                    if(ai[pos] === ')' && ai[pos-1] !== '\\)') {
                        // Subtract pci
                        pci--;
                    }
                    continue;
                }
                if(ai[pos] === '"') {
                    pq = true;
                    continue;
                }
                if(ai[pos] === ':') {
                    // Mailing list name, ignore
                    cn = '';
                    continue;
                }
                if(ai[pos] === '<') {
                    pa = true;
                    continue;
                }
                if(ai[pos] === ';' || ai[pos] === ',' || ai[pos] === '@' || ai.length-1 === pos) {
                    // Looks like it was an e-mail address this whole time lol
                    ca = cn;
                    cn = '';
                    pa = true;
                    pos--;
                    continue;
                }
            }

            cn += ai[pos];
        }
        if(ca)
            parsed.push([cn,ca]);
    }

    return parsed
        // Only non-empty addresses
        .filter(a => a[1])
        // Unescape quotes
        .map(a => [a[0].replace(/\\"/g,'"'),a[1]])
        // Remove extra spaces
        .map(a => [
            a[0]
                .replace(/\s\s+/g,' ')
                .replace(/^\s+/,'')
                .replace(/\s+$/,'')
            ,a[1]
                .replace(/\s/g,'')
        ])
        // Convert empty strings to null
        .map(a => a.map(a => a || null));
}

function foldHeader(string) {
    string = string.replace(/\s*$/,'');

    var out = "";

    while(true) {
        if(string.length <= 78) {
            // Short string
            out += string;
            break;
        }

        // Last foldable <= 78 OR first foldable
        const match = string.slice(0,78).match(/.+\s/)
            || string.match(/^.+?\s/);
        if(match) {
            // Fold
            breakpoint = match.index + match[0].length - 1;
            out += string.slice(0,breakpoint).replace(/\s+$/,'') + "\r\n";
            string = string.slice(breakpoint);
        } else {
            // Long string
            out += string.replace(/\s+$/,'');
            break;
        }
    }

    return out;
}

function randomHex(len) {
    return [ ...crypto.getRandomValues(new Uint8Array(len)) ].map(a => a.toString(16).padStart(2,'0')).join('');
}

// "Secure contexts everywhere" actually fuck off right here this is bullshit
function uuid4() {
    // xxxxxxxx-xxxx-4xxx-[8-b]xxx-xxxxxxxxxxxx
    var random = randomHex(16).split('');
    random[12] = '4';
    random[16] = (crypto.getRandomValues(new Uint8Array(1))[0] % 4 + 8).toString(16);

    return random.join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5');
}

// [1,2,3] -> "1:3"
function compactUIDEncode(uids) {
    if(typeof uids === "string") {
        return compactUIDEncode(compactUIDDecode(uids));
    }
    if(!Array.isArray(uids) || uids.length === 0) {
        return "";
    }

    // Make sure we work with sorted unique numbers
    const sorted = [...new Set(uids)].sort((a, b) => a - b);

    const ranges = [];
    let start = parseInt(sorted[0]);
    let prev = parseInt(sorted[0]);

    for (let i = 1; i < sorted.length; i++) {
        const current = parseInt(sorted[i]);

        // If current is exactly next number → continue the range
        if (current === prev + 1) {
            prev = current;
            continue;
        }

        // Range ended
        if (start === prev) {
            ranges.push(String(start));
        } else {
            ranges.push(`${start}:${prev}`);
        }

        // Start new range
        start = current;
        prev = current;
    }

    // Don't forget the last range/single value
    if (start === prev) {
        ranges.push(String(start));
    } else {
        ranges.push(`${start}:${prev}`);
    }

    return ranges.join(",");
}

function stringToBytes(string,charset=null) {
    const bytes = [];
    for(i=0;i<string.length;i++) {
        bytes.append(string.charCodeAt(i));
    }
}

// "1:3" -> [1,2,3]
function compactUIDDecode(compactUids) {
    const uids = new Array();

    for(const uidIter of compactUids.split(',')) {
        if(uidIter.includes(":")) {
            const uidIterSplit = uidIter.split(':');
            for(var i=Math.max(uidIterSplit[0],1);i<=uidIterSplit[1];i++) {
                uids.push(parseInt(i));
            }
        } else {
            uids.push(parseInt(uidIter));
        }
    }

    return uids;
}

function hex_encode(str,bytedelimiter=null) {
    const encoder = new TextEncoder('utf-8');
    const bytes = encoder.encode(str);
    var hex = '';
    for(var i=0;i<bytes.length;i++) {
        if(bytedelimiter)
            hex += bytedelimiter;
        hex += bytes[i].toString(16).padStart(2,"0");
    }
    return hex;
}

function hex_decode(str) {
    return str.split(/(\w\w)/g)
        .filter(p => !!p)
        .map(c => String.fromCharCode(parseInt(c, 16)))
        .join("");
}

function decodeQuotedPrintable(string,isEncodedWord=true) {
    const bytes = [];
    var i=0;

    if(isEncodedWord)
        string = string.replace(/_/g, "=20");

    while(i < string.length) {
        if(string[i] === "=" && i + 2 < string.length && string[i+1].match(/[0-9A-F]/) && string[i+2].match(/[0-9A-F]/)) {
            const hex = string.slice(i+1, i+3);
            bytes.push(parseInt(hex, 16));
            i += 2;
        } else if(string[i] === "=" && i + 1 < string.length && string[i+1] === "\n") {
            i += 1;
        } else if(string[i] === "=" && i + 2 < string.length && string[i+1] === "\r" && string[i+2] == "\n") {
            i += 2;
        } else {
            bytes.push(string.charCodeAt(i));
        }
        i++;
    }

    const byteArray = new Uint8Array(bytes);
    return byteArray;
}

// Take a based64 string and decode it to Uint8Array
function decodeBase64(string) {
    const bytes = [];
    var i=0;

    const bdata = atob(string);

    for(i=0;i<bdata.length;i++) {
        bytes.push(bdata.charCodeAt(i));
    }

    const byteArray = new Uint8Array(bytes);
    return byteArray;
}

// Take a unicode string and encode it to based64
function encodeBase64(string) {
    const encoder = new TextEncoder('utf-8');
    return btoa(String.fromCharCode( ...encoder.encode(string) ));
}

function encodeMIMEWords(string,method="B") {
    // only b64 cry about it
    return "=?UTF-8?B?" + encodeBase64(string) + "?=";
}

function wrap(string,length=78,hard=true,endl="\r\n") {
    return string
        .split(endl)
        .map((a) => {
            const match = a.matchAll(new RegExp('.{1,'+length.toString()+'}','gm'));
            if(match){
                return match.toArray().join(endl);
            } else {
                return a;
            }
        })
        .join(endl);
}

function decodeMIMEWords (string,escape_html=true) {
    if(!string) return null;
    const r = new RegExp(/=\?([0-9a-zA-Z-]+?)(?:\*.*?)?\?([QBqb])\?(.+?)\?=/);
    const rs = new RegExp(/\?=\s+=\?/,'g'); // idgaf
    const rg = new RegExp(r, 'g');
    const match_all = string.match(rg);

    const encoder = new TextEncoder();

    if(match_all) {
        string = string.replace(rs,'?==?');
        for(const result of match_all) {
            const [original, charset, method, encoded] = result.match(r);

            var i=0;
            var decoded;

            try {
                const decoder = new TextDecoder(charset);

                decoded = method.toUpperCase() === "Q" ?
                    decodeQuotedPrintable(encoded) :
                    decodeBase64(encoded);

                decoded = decoder.decode(decoded);

            } catch(e) {
                log('decodeMIMEWords','Decode error ' + e.message, WARN, [e,original,charset,method,encoded]);
                continue;
            }

            string = string.replace(original,decoded);
        }
    }
    if(escape_html) {
        return escapeHtml(string);
    } else {
        return string;
    }
}

function decodeDate(date, full=false) {
    if(typeof date !== "string" || date === "")
        return null;
    const decoded = new Date(date);
    const now = new Date();
    if(!decoded.getTime())
        return date;
    if(!full && Math.floor(decoded.getTime() / 86400000) === Math.floor(now.getTime() / 86400000))
        return decoded.toLocaleTimeString();
    else
        return decoded.toLocaleString();
}

function decodeSize(bytes) {
    var label = "byte" + (bytes === 1 ? '' : 's');

    if(bytes > 512) {
        label = "KB";
        bytes = bytes / 1024;
        if(bytes > 512) {
            label = "MB";
            bytes = bytes / 1024;
            if(bytes > 512) {
                label = "GB";
                bytes = bytes / 1024;
                if(bytes > 512) {
                    label = "TB";
                    bytes = bytes / 1024;
                    if(bytes > 1023) {
                        return "fuck off";
                    }
                }
            }
        }
    } else {
        return bytes + " " + label;
    }

    return bytes.toFixed(2).toString() + " " + label;
}

function escapeHtml (string,escapeChar="") {
    const entityMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      "\\": '&bsol;',
      '/': '&#x2F;',
      '`': '&#x60;',
      '=': '&#x3D;'
    };
    if(escapeChar) {
        return String(string).replace(/[&<>"'`=\/\\]/g, "_");
    } else {
        return String(string).replace(/[&<>"'`=\/\\]/g, function (s) {
            return entityMap[s];
        });
    }
}

function escapeRegex(string) {
    return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

function escapePassword(string) {
    return string.replace(/[\"\\]/g, '\\$&');
}
