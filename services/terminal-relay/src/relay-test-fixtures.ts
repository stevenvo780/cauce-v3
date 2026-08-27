import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';
import { AgentLeg, createAgentTlsServer } from './agent-leg.js';
import { BrowserLeg, browserWebSocketPath, createBrowserHttpsServer } from './browser-leg.js';
import {
  decodeDataFrame, decodeJsonFrame, encodeDataFrame, encodeFrame, encodeJsonFrame, FrameDecoder, FRAME_TAGS
} from './framing.js';
import type {
  AgentPresence, AuthzOutcome, ConsumeOutcome, ResumeOutcome, SessionCloseReport, TerminalGatewayClient, TerminalSessionGrant
} from './gateway-client.js';
import { CLOSE_CODES, SessionManager, type SessionLimits } from './sessions.js';

export const TEST_CA_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDPzCCAiegAwIBAgIUb+WnuMaYt0OTYaQemgPtnN+2sBswDQYJKoZIhvcNAQEL
BQAwJzElMCMGA1UEAwwcY2F1Y2UtdGVybWluYWwtcmVsYXktdGVzdC1jYTAeFw0y
NjA3MjUxODAwNDhaFw00NjA3MjAxODAwNDhaMCcxJTAjBgNVBAMMHGNhdWNlLXRl
cm1pbmFsLXJlbGF5LXRlc3QtY2EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQDilYQE+6TQNn3zghFMC+7bWSkuAsL8UfUzEba07rn5Fm9rBJSJBUIE+tor
XPlmRL3d/1CAen/XCq43eDMy9j2AHQEKqTdNbe9iZ1FbUs4viBXS8U1/D5OFOMKw
pHfiZGncKIpDnTDWQXpJ03YzT/2Mas//LFQdGFhzDYwJbh3UYIWqYsNuFeNaUwV6
M+kPZJfvvUKaQC24KnB5a5fz7AhRQEADBla3KBI0DrKvxDjdlymJb2Oh4p+v/jCQ
5dJ2hM7iQiUPm5RFgdDDjFv1tWE7TDVGWDyanFF7VZ5dUSVdFGm0xCFCMk42cM4H
HfNs8QeJmmHOQgDhyrbqshGUbqqDAgMBAAGjYzBhMB0GA1UdDgQWBBSGPHr44Bo7
elG+EZyFVvgtbNXonDAfBgNVHSMEGDAWgBSGPHr44Bo7elG+EZyFVvgtbNXonDAP
BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOC
AQEAFaRaOazVtTpJWNB/8+7TajYZCx2JbqdywbOG8gFlVGn1BDmZriwN8kr5X7p9
7vqXw17vt3AdD5khKdvYWIDk0Oaeb4Iu6S+3Ck/HE8H8QFNQpefiyA+2DjWBsYG2
UfPtH8WcenIfGTor9/daXDQc7NCd4ZVVGTmI4hZbZtgyTLA0QWTgMybvnPt0WV7N
M7ruovEdeYlI9X4sy+wduxr59XrTBYDzZ0E+0TXgbH8dEhgdi2f31aroOOuniVH1
WDB5Yh0A3Qch2b7bPnesKiLzygtqD6vPaw6Ztj8m+mcCf+LZWUV1Fl/GDnZoquco
0Jp7ilayPL193m8GGpVA0baHyg==
-----END CERTIFICATE-----
`;

export const TEST_SERVER_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgIUKdWBLdF9aIWJwWgaYK5IgjZgY6AwDQYJKoZIhvcNAQEL
BQAwJzElMCMGA1UEAwwcY2F1Y2UtdGVybWluYWwtcmVsYXktdGVzdC1jYTAeFw0y
NjA3MjUxODAwNDhaFw00NjA3MjAxODAwNDhaMBkxFzAVBgNVBAMMDnRlcm1pbmFs
LXJlbGF5MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4LzaGHmdTJSn
0zgvWYtKlbiq1YDOUgVusoAhVgUKOVOtaEpOcVGU+1UNqIxonSpRJPJ7yGg045wu
zQOClMbyMvlMK1AfyiAVd9HZqmOubkhogCf59sdagGyxA7NgGqW+TI/TRqasNIHw
q9Y4AID58+cgXgTVpEnLbWgyeir2qem0IpwRemb2YY9HS2XVknJAcRIHNwhb4Jm3
PJfKTZyzJ1P/Uyox3go2QEL48pJByRwqvF9ENKDnGxl9EK3600iz6HoO3x6q764f
tJBqusr+Arr6gh9OjxWUZ7XCrFV3pyuYr2m7lCa5UXsFnspbp2wttZhXIbKHtML9
uXJkMuhWNQIDAQABo3MwcTAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwEwYD
VR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0OBBYEFM/fkLeqg41yIPbkbQzXjDpUldoZ
MB8GA1UdIwQYMBaAFIY8evjgGjt6Ub4RnIVW+C1s1eicMA0GCSqGSIb3DQEBCwUA
A4IBAQATziPAw/aeP0QVt0Njkza84AARnvTMbv10iD7HFy8g/g9zFUuNGFtarsux
d4bBPZwD2YsAlXIh70KIxuGPsGwL0NS6Tm9KfNX64qX8aItz1vb3NfUUP16XMnQ1
p1IXNoMqr1uH1cCLEgnfpMcDfEOu67OE6TeU4NlV+gCU7xyvJ19iHASsu6MgFUJp
g0J2D+EUjVAXs6z0MdCNFP4J4uvz4DtaKi3W7PWLyAG4MBRgn4QDIR4mSUg/+8Nt
Nu/ia6D4gXNsOeURyo4Ao+waiBi/8l7p2HbJxya7A5UF/e5xbUr0xJRq5+oNJ7FM
YMxpLgeDet0igWO3A18HTKKf+WBe
-----END CERTIFICATE-----
`;

export const TEST_SERVER_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDgvNoYeZ1MlKfT
OC9Zi0qVuKrVgM5SBW6ygCFWBQo5U61oSk5xUZT7VQ2ojGidKlEk8nvIaDTjnC7N
A4KUxvIy+UwrUB/KIBV30dmqY65uSGiAJ/n2x1qAbLEDs2Aapb5Mj9NGpqw0gfCr
1jgAgPnz5yBeBNWkScttaDJ6Kvap6bQinBF6ZvZhj0dLZdWSckBxEgc3CFvgmbc8
l8pNnLMnU/9TKjHeCjZAQvjykkHJHCq8X0Q0oOcbGX0QrfrTSLPoeg7fHqrvrh+0
kGq6yv4CuvqCH06PFZRntcKsVXenK5ivabuUJrlRewWeylunbC21mFchsoe0wv25
cmQy6FY1AgMBAAECggEAHu6qD2pVwIpJcHoFkmE9+njjZ+WFqvu9GRZ9ACD2H55+
efdC8A1BizemsfHkHZW10MxgmzHfQwtmfv33sCXohM7pW/Yi71LBLFpsMivsK0O4
wRg/gGbp9E6BgrfishLpVr0JCxVlEwkQ03tK/qQXQynRu6nAr2R0z8c4A2FRzWBE
89rFul1VtvJ0VAoqCUMfJUogP4iqctR2BYBzYgKS7lk1+T2x1j0gJznBGQgABgsD
ISN1jycb3ovcUBZ2V59seYMfyOfpWs6hCWOb7NtBZjYNsta26yaQLVLeoSgnhK7s
fohXJ6RWlqB0TrzjkjTE5vSh32WpQ+bQDL1kklt91QKBgQD1ONf7XA/sXd36CWtK
rwCIFSD+97TIVXTJ6ynzYvU9yGTz8Qma/oqhDSvP6IKrNpjlwK4NHVMgTbKUHCXz
LGTsWyZdKXCD+OOntB3BcuBIKYGAxDm5FT/wA8mY6YV2KfNzPEUR/1rk848DLZ4+
WKp1TbOrwk+iNyD9cLH299QmtwKBgQDqnYZ5oCGC9p+Vq5ilrUVqlduqXY3QMne+
umT89iiqk6HLJVO/VffnfhfEGySgOthNLkmAzkWQh7BLyVLv4FG7SLvNv6QUSc3G
VyQToLHgT6lkJbz4FRvJ/O3R6eX7PZjVQMD/5VDtP3pi019EF2VeIFmmBtzFahrd
ZgcQ4PqecwKBgEDOjQX5BpxJEmkKJDjQlytfqiC4BicLrpnOdH/GH1n8o/F0Oj2k
F68IdBO2NxJYk3/ktBrzLQzUe+V4qu7hRKrSTAlC8mFuXXvsthBx86QelAMb2MV5
QDSGS7kFvifEXnqN6xMekT8Av0Lvw2pmtGXb6yfxampMd4ODTQUf6glxAoGBAJH9
1eknINNKvgE3lzQ5PwHVIKzBrHZKgUL439CdKK8EUOCFaLieOTYeu5E3RrJCC8jz
LZ/uO1F1bdmq/GXyE0nUN7EPOH27c0WhgfyIuUcYqxJ7fTxufi1Rq3c88fRF3y2M
LszNmG8ZWgHW/+fyGwzYWpC6onRh0zfDvk/df3ZLAoGBAOQP20DymqfKb8HNKt/P
PsYY9oP/OTibbfV96/a9EwH3Me+wl0IFGrkojMuKn+/Tv41z19bE3HzrSV7V/FS4
sPueVr1bVM/lszarvRlV9hwGT1I7xW9tC2hJmv8zFFlA0fpdkMsGyY0mI4qP/jZj
1lb4R2a4KwSIaSaUHWICZzUW
-----END PRIVATE KEY-----
`;

export const TEST_CONSOLE_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDHjCCAgagAwIBAgIUKdWBLdF9aIWJwWgaYK5IgjZgY6EwDQYJKoZIhvcNAQEL
BQAwJzElMCMGA1UEAwwcY2F1Y2UtdGVybWluYWwtcmVsYXktdGVzdC1jYTAeFw0y
NjA3MjUxODAwNDhaFw00NjA3MjAxODAwNDhaMBIxEDAOBgNVBAMMB2NvbnNvbGUw
ggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC07mSqXawK8oWD1fl/pT1X
AtyT0Bsm5VXHTsjKN4aqT4GSraJRl4D5wiTBAe3lfiUL51S3C1GaBkcu++gOZgfM
1sgMsMCSmmZsLtGF3N+rBNzz7/tVTTv0wwNf3dLqSqaE9MIuBpJICzTDkTmOq31S
1reZ4McOz0zea+1guXl0vDOgx38lB0gMDjNAhdKDnUupwkeyj0Ban5BhiGhxuCQ7
vcQntDSPvEdpUhSPWzyeJG7oiAkqaoGbChVL0vlxATWtLbZVEqRXs8Bsqsn11dfa
dpnqWACPpQ8Ge8B/7pQyytuOBzJtJz2PBtH2nCWtEj5aL0smC7oozk0+IsZEL8P7
AgMBAAGjVzBVMBMGA1UdJQQMMAoGCCsGAQUFBwMCMB0GA1UdDgQWBBTZ8d2qNe/X
sxnScSa7IwGN2u6ElDAfBgNVHSMEGDAWgBSGPHr44Bo7elG+EZyFVvgtbNXonDAN
BgkqhkiG9w0BAQsFAAOCAQEAoUiZrxm2+XUr6p1BCyb0BPbuV2xO8XDfyQxbUSjz
x+UA+Jli5eL8A2fo8awdQXf0a+2WgtN6pzvVaEXUlpPzyu+oxsLdcTar7oYn2y/k
xdrEFm0gGWvFOf6jvI9hTpB0ZA7EPiUhl3Gc7uVs0/rEPiq5iHFzviTCGyb+j/DT
8wvW9FQmKNRThmSFxwzqXTWa/F4vcwPd8yWDDRFFPlZmKZ5p3TZXXV/rntgDB34+
/Cl6T2FmyQcUVocQxwd3LkvwvMNdGM9gt1tnzcfUHNrXZocbi81078JMMhtOpiN1
4M6Nvl8437NBpzhwNcmz3wfryQ+nQ98H4CwPdePJnMfkSQ==
-----END CERTIFICATE-----
`;

export const TEST_CONSOLE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQC07mSqXawK8oWD
1fl/pT1XAtyT0Bsm5VXHTsjKN4aqT4GSraJRl4D5wiTBAe3lfiUL51S3C1GaBkcu
++gOZgfM1sgMsMCSmmZsLtGF3N+rBNzz7/tVTTv0wwNf3dLqSqaE9MIuBpJICzTD
kTmOq31S1reZ4McOz0zea+1guXl0vDOgx38lB0gMDjNAhdKDnUupwkeyj0Ban5Bh
iGhxuCQ7vcQntDSPvEdpUhSPWzyeJG7oiAkqaoGbChVL0vlxATWtLbZVEqRXs8Bs
qsn11dfadpnqWACPpQ8Ge8B/7pQyytuOBzJtJz2PBtH2nCWtEj5aL0smC7oozk0+
IsZEL8P7AgMBAAECggEATeiJOEL1nhEoJMiykqBYdWsqCAwIZQtDkHsAQvL97cAm
jz5tMq0GQIW0xddK1RMoaKPH+rnI/YXOiRC3r9uHaFDj+3LwuS/7AoJ2finJth51
9iRUGTsUoiSHA3TFKVXTtlSeeKsjuhn5Mm0KV8DISi9jB8Oec2YYN35JzOiQwA6+
xx7ffImcTroauEeX3LdZDCofMM/jlBxFmR9ySXB1yAVSb4bbO88A5gKEHO48XZB8
fEGAHyo5jJge/Bd5w6n7ntBG/dZnSVcMN5Ido6do1Tg+cNWc2879i7xj8f6HCY6o
ywoZYVZw5L1ZNEcAjBBWNmyQTLgEItOnLFzkgIsjAQKBgQD6QHpjlc7pgdPxrfhP
14wTaba1NRqrqxeVtSjUem8YEPehk65vzcFfvs0Y2TlIO0cEzw/ZVAFx1sh2IE5J
15XEWR56jiLq/AB+7PlzkOWfGVUIpFHnublriSNUMKHb4qPd0BmdFpmphfCHoAtc
xXCWjV9lo9bzrH+XR6bvk+msIQKBgQC5FkxlAiEHjv7XoY3ohmjDOzC8Op/Un0a4
jAhjJx9AtI+u7Q60zcoFVs/ueNLf/r5DHwoghMf66acCcotrGTjwSXb++nNJvmoE
FB5wgR+SKIBHIXumOwP5dqayERUetlsBIy1MXxT6g/fv+G/dmLNg+vq52DOt0kWM
ajNCFUMMmwKBgQCAHxzJ+XvavxZUqL31mqRjl/7r3UlPVKQZiItj5V8VUjKF7cck
BJKZQ2Vb8HLMUVT12FED8mde8hjlqXqLga1yvjHFixnDdsuGMCsyiJ+XCfAoIYCx
g7uzm52Tz+Y+XlWJDa7fZx+61BEmTsEieQ9AdRa/QdeeH9WfDRchl3fOIQKBgQCZ
uYt52WrVfE7tiaDzn68jd+XicE6PqjpyzNuqfrPWaiFsiDfOs503EgNhbbi3kj00
QnOGzsHKBIZR4hEpwqkn6dyLqjhW52/mM0+U4an3GuxwJ78rMZj7eTC6dLW17H9p
Um4tIEusRi+HgDBpPIq/4bSc5pUFqb9aAFrSaBZoQQKBgQDkM782kNbnzP3XP38N
ZnS6+3E0itgbjwRGBta8XUfUKKqnnPwsh8waHhMFjNvK3aFnEwAT3XGGw0JxLVQc
U4I5MQTmMz0l0BVkxCaijPkTxAhS56uHbD5jKXnukEmEAayWAynILqd0JqguNPgF
JEV/teuOy3cqnvHKl3EIKTuOwA==
-----END PRIVATE KEY-----
`;

export const TEST_AGENT_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUKdWBLdF9aIWJwWgaYK5IgjZgY6IwDQYJKoZIhvcNAQEL
BQAwJzElMCMGA1UEAwwcY2F1Y2UtdGVybWluYWwtcmVsYXktdGVzdC1jYTAeFw0y
NjA3MjUxODAwNDhaFw00NjA3MjAxODAwNDhaMBsxGTAXBgNVBAMMEHB0eS1hZ2Vu
dC1qYXJ2aXMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDEJQnbWl2E
BsrI3K9MNWGB1DRRTdcI1nlu7SFm8urSzG0bWRQh/yDo88OUXd6ztNmE70XLS0Y/
4ozLV7fg5TAe/uO2OfKqbb7bhVCsWVF+96L0Q+azX6Cd4GeJgZIKj59ibAHvBe+9
8cgWsjnLh+R5L1djGBh/0Shh/LrWaYgBgOFs44tXI1A2o74Dol5gnpqzBYgz3Zq7
f34fwfBIpiqd1isQezCSAr377nNbJtMSNc3W4TWg5ZusSb6WvBGPl2I3X2a1YeRL
bgPrlQBl88mUB10KGCiXFPRCuFdJp1iMTjnHuCdUe5b1JA7SK6aHiIm7HtUgT8OC
L5RW9CsrCiGjAgMBAAGjVzBVMBMGA1UdJQQMMAoGCCsGAQUFBwMCMB0GA1UdDgQW
BBRr+yQwM6lyzg5yVjc7N736ZMs/STAfBgNVHSMEGDAWgBSGPHr44Bo7elG+EZyF
VvgtbNXonDANBgkqhkiG9w0BAQsFAAOCAQEA2NPxapNSNrdz8NIVMSD9aejpgtvJ
QwuL9K0CuaPBGvReGI2RG8VOfG6LItoNpWLbcgYVsc6lOCUWvsj3yg72OsCO/Zo3
OhXArw089k41FYuULMXIegRRVhrbXw5udVyp9yqmWAQSK6PVeH37vTJNz4KQmDOP
doYWtjpoIdwF8YzXbgsxu2SxAGIBDEq1jnOTM786l/yyn3i3GVsGFntH5GPrpPZI
45f/MdWnjJqApE9X56VUaGgq8R1A98hsvkj0PAGxXi5/7SOVTgyx+WnuYNyB1YQf
IGWa2dS4DeyptwpKnHGf3r4HAyfXHQ8Aypcj20NdLMpn9ByGc1OwGcOi7A==
-----END CERTIFICATE-----
`;

export const TEST_AGENT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDEJQnbWl2EBsrI
3K9MNWGB1DRRTdcI1nlu7SFm8urSzG0bWRQh/yDo88OUXd6ztNmE70XLS0Y/4ozL
V7fg5TAe/uO2OfKqbb7bhVCsWVF+96L0Q+azX6Cd4GeJgZIKj59ibAHvBe+98cgW
sjnLh+R5L1djGBh/0Shh/LrWaYgBgOFs44tXI1A2o74Dol5gnpqzBYgz3Zq7f34f
wfBIpiqd1isQezCSAr377nNbJtMSNc3W4TWg5ZusSb6WvBGPl2I3X2a1YeRLbgPr
lQBl88mUB10KGCiXFPRCuFdJp1iMTjnHuCdUe5b1JA7SK6aHiIm7HtUgT8OCL5RW
9CsrCiGjAgMBAAECggEAIGcH/lMq0LU4ib8fPGUzIvn13JqR0/VuYRtOYc3uaf14
ZsSr9UPK4YDnhdqOADz3lCTc8E0SoVohLTRj/YSPEwfDgWaIRoxTs7sNzTMCKgnp
wxV2hppdE8evAwHDKPh5+Y3jMePWq5fGGK2/q3ZbEYP3GTkxTug0Fh/kk6giXjDs
t3z9cV1qknFFBvjVGd1z2wpfd5Z2VlMcReX/8l/OWbNtpja2YqpDOcVZnIkhqpnh
puopc3uhBCWWYKeFfVUUkohvyhMwIffQ7t7nOCneWOJ3qaigWiv8jWZd9ltZaISX
84qXUlQO7bJonMl8T79aO5DHwvahd776QGXBvE7STQKBgQDoF2Z1fBMJPTAuY3RQ
cEduNNyrmSLYTRmW1YcZ3tu8J+oLg2c8DXhOj/STq8lKjPoRjID49+cKaFkAYZBS
/fNkE1nHrsJS4sNGJTrmgIWGUeAFxoPOWFhLr/pSAOrZY49UXk4X9xRk6cOAI5Um
WMkbVRj3ERM+1ZXbaKGbyOh4lwKBgQDYWatEW78phu1iYsN4RNA/DgnHgGbXvbT4
6uhabhmgnOtYswhUuR0Kg1YSMeVHQ8HfGg90Y7v7MQiBnypAVwJsjTKfhawPUYTg
BWs69o9XwNP3DvwS9UYL40UBWoi96v60aiuCM7f2i73bHK4Mqv16XXyMmCjGlugn
ucsdTZ4U1QKBgQChFxzWjrfnwcCfcghZjJUHuUkxEalN2LXaK3sKSdTaVBnuw9Xz
qKXIYcKwfJvKUu9/HramF+sVHjgoO4+hCwLUg1ndbz8RqLNBDLZFJw+Gm22SlKcH
oeonHo3wPRLEsIXbWVl66NQO9vHrDseHRjjP79DUK9Xf1v+cupLxPhGdIQKBgA1d
1N//Txsws9/dPDhk//y1UFNcEn6HwPOUB9D2dmze5Qdw4DXjzfCFVr7/CCxT+llf
Uc8eDlIhoGXpwIGDHqo4OwVyC8RShAQXMZ3N9+MzDaV47of5UV+QpgXEYyhgqWXa
HWAI8/eugIdWCUbNFaYGupgxGmvSjPtPVkY0Mm0VAoGBAOFTXOn7a5LWW3lApTW0
avkOuG2NulPHvUvbyeE0PIX9UVoAbZ5AojTunhEGjSVEZlLdD/DP0LaSIAt9bli9
jk7NG326Jp72faUclg9pTTHo8HtT6fXZQncOncb/ExLExkDhRcyAA0U+9Om5LEss
Ac3Hmv1/lEjmiWF5i9MTV1Mm
-----END PRIVATE KEY-----
`;

export const TEST_INTRUDER_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDKTCCAhGgAwIBAgIUKdWBLdF9aIWJwWgaYK5IgjZgY6MwDQYJKoZIhvcNAQEL
BQAwJzElMCMGA1UEAwwcY2F1Y2UtdGVybWluYWwtcmVsYXktdGVzdC1jYTAeFw0y
NjA3MjUxODAwNDhaFw00NjA3MjAxODAwNDhaMB0xGzAZBgNVBAMMEnB0eS1hZ2Vu
dC1pbnRydWRlcjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAM+RDui4
UkY4eBrlQShznDDUv3epDtP4b8JOOkvxzYyrhNawXNziEQoPHTKJt0v+12AA7r2T
pdI7KeTcA3dQ8Q1cQNfbTeqkbDxZkffNnqf1SyOzxm7iYRC/j94/TrbqPKEatPQj
lb8Ngw73D9duFF+YMYdyP/fFQXhUXKvMuY85K9De93N9es2gKAKoCodkCilr7bLO
6D8lQA6s6euEVVY+EaBf6CdsbUvJHZuVPZXmPlguZk0wogBjEda32DuYjIEPnJQz
Cwu4Cz47vtGL4tsBDUNbc6iH+5xdm0ORDODK6pWUWRX5+YXSXWISwVbWVzjo+zmw
sauc6yt9LgQ/SO8CAwEAAaNXMFUwEwYDVR0lBAwwCgYIKwYBBQUHAwIwHQYDVR0O
BBYEFJGElJErTs16ti7MCeoWU3ODFS09MB8GA1UdIwQYMBaAFIY8evjgGjt6Ub4R
nIVW+C1s1eicMA0GCSqGSIb3DQEBCwUAA4IBAQCKhXm6NT0ep9EhOnU/GEQ90xwj
6Nl88hY4i1X/ACShhI+HfAO5/AQlTqn0Gr2SymA38F2DRnoUgvd2FOKsJCRWXd7g
7TbOWjnPs6DuygdO+fVk1DynI1fkejdK/IMogO2uquZI1gWCXKiXgdyE0vAep/VL
PGb7tfgxo4l5cYdjnVTj516MhLqu0935h/DtOj937KNwerBK72tWwCHUZihS+KNV
Fo2omlcNoyWTuT2ltljcLYvHDXX2ydJRDeythuOO3jh/TEuLpHwKsge3R75gcQUv
J78I2kyeO+PsLxC68BqQRHsF8SXQLE+t8UWO09bWwtG21kNH9vPYOq+Qc8d4
-----END CERTIFICATE-----
`;

export const TEST_INTRUDER_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDPkQ7ouFJGOHga
5UEoc5ww1L93qQ7T+G/CTjpL8c2Mq4TWsFzc4hEKDx0yibdL/tdgAO69k6XSOynk
3AN3UPENXEDX203qpGw8WZH3zZ6n9Usjs8Zu4mEQv4/eP0626jyhGrT0I5W/DYMO
9w/XbhRfmDGHcj/3xUF4VFyrzLmPOSvQ3vdzfXrNoCgCqAqHZAopa+2yzug/JUAO
rOnrhFVWPhGgX+gnbG1LyR2blT2V5j5YLmZNMKIAYxHWt9g7mIyBD5yUMwsLuAs+
O77Ri+LbAQ1DW3Ooh/ucXZtDkQzgyuqVlFkV+fmF0l1iEsFW1lc46Ps5sLGrnOsr
fS4EP0jvAgMBAAECggEAMeTbEhrYgBOr3z8zae9cYKqLOc7UByUFbE4UmlPOBp3m
KRssv1XCJcpbSN4sxuJD0Ep5GO3oYsAhAmfWl3RH9V+zIJARSzFp6RnYyhnNpO8E
OFlK/jWBgp6hjRlnqPVmTI2YaMUzBkFPuyWtU6oc0JvLcBUJBlyOr8eLnSpxglkb
FsOXT5mj9BfKr2TT0RaA76bJqdtU0w/JK4fLAXnqCMkUljMKbZzgCLyeRJWtPVJU
dqHGcNO0pO+lUNyh/pHI1mkt7qvmcrvWh37DXIGzzxR/lOy7EfmpCkild44EytK+
8ZdFrh4A64Mb2hGbRJqDwrf1huHDTZcm77chrbVJ4QKBgQD6pakGYsfyDC4QRF+U
ZzClsw2tHUYftvGOf59gqgqtgJQTAjpstL3g7Lzu3Bmf2LuchlqN6+SCM6DzlABs
OkIX+bf0U6FtwxRU1ZyWdizJiMLCpLPKaxVacjEjhQ+oDG7u1ypGkBv/rDpRYwUU
U0/e47MkiGPkaEqEaX45e1VfTwKBgQDT/946qPe2gTZPsLSnI2OEeRpL2fTeoEqS
AOtzUDtaABNbGiSHjU+tJXyBR742hlpa0ov6EtJvEyyq7oQfMdMB76UiI/Rj5syx
EKVJTuofq6n/CE9Ghh2ZbB9sOj54ISAYskvTdxewQo31JTnnYbMalsCnQJMfSf5O
LFQ7DkwUYQKBgQCjLjUT1j3MRMe8iXccm+3dAux1dyiPP0CWgFoXyby35o0AryOw
YB96j0YV0C/SlHzYU9Qir6AOcGRqEEISM/+Rsl9j7wqa9jWHYabXgkp4TtRVense
3oaBYvTA5kEiLC4Qyv5YADxqQQuarvfAmtjWCLI5p545NvjEqhWmgLg9GwKBgGHX
BpMABELgY1Zn8RfqBzXORkqXbqGITKIRdpijgKDKxCQZbp54ozr/v/RSTgEQBIdC
AIQLR78nlEfXCHb1IbMVDJszCMlKbVGSoxWwK/Et4qjnBt8/ak2yTtY+EzKR5yQ+
tSwFHJOmQ6nN4mlc97HfvU3zSXL5TTp6zuzqbkZBAoGBAM27Lajg0mUMVWnk1xFA
wrzCSlHYvHXX2bWITNKC2Y6YNcHOMGMVfcSmrY7ICr0qevkQ24nQTncCV4HDpk9k
IDOmSEnZxa1Jr4r/4DWrluXouq3xuTMYsPu8HtOXJOLjnfBrW32RP18JmZI2Q8Kl
VbuY1WcOsIxcwvyUBBnxHB0G
-----END PRIVATE KEY-----
`;

export const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const CLAIM_TOKEN = '12345678-1234-4234-8234-123456789abc';
export const RELAY_INSTANCE_ID = 'a'.repeat(64);
export const RELAY_BOOT_ID = '11111111-1111-4111-8111-111111111111';
export const AGENT_FINGERPRINT = new X509Certificate(TEST_AGENT_CERTIFICATE).fingerprint256;

export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was never met');
    await wait(5);
  }
}

export function grant(overrides: Partial<TerminalSessionGrant> = {}): TerminalSessionGrant {
  return {
    tenant_id: 'Steven',
    alias: 'jarvis',
    mode: 'shell',
    cols: 80,
    rows: 24,
    operator_id: 'steven',
    container: 'claw',
    runtime_user: 'claw',
    session_expires_at: new Date(Date.now() + 60_000).toISOString(),
    resume_token: 'r'.repeat(100),
    claim_token: CLAIM_TOKEN,
    claim_epoch: '1',
    claim_lease_ms: 150_000,
    claim_lease_ttl_ms: 150_000,
    relay_instance_id: RELAY_INSTANCE_ID,
    relay_boot_id: RELAY_BOOT_ID,
    ...overrides
  };
}

export class ScriptedGateway implements TerminalGatewayClient {
  consume: ConsumeOutcome = { status: 'granted', grant: grant() };
  consumeCalls = 0;
  readonly consumeClaimTokens: string[] = [];
  resumeCalls = 0;
  readonly resumeClaims: Array<{ token: string; epoch: string | undefined }> = [];
  resume: ResumeOutcome | undefined;
  consumeGate: Promise<void> | undefined;
  authz: AuthzOutcome = {
    status: 'allow', claim_epoch: '1', claim_lease_ms: 150_000, claim_lease_ttl_ms: 150_000,
  };
  readonly closeReports: SessionCloseReport[] = [];
  readonly presence: AgentPresence[][] = [];

  async consumeTicket(_sessionId: string, _ticket: string, claimToken: string): Promise<ConsumeOutcome> {
    this.consumeCalls += 1;
    this.consumeClaimTokens.push(claimToken);
    await this.consumeGate;
    return this.consume.status === 'granted'
      ? { status: 'granted', grant: { ...this.consume.grant, claim_token: claimToken } }
      : this.consume;
  }

  async resumeSession(
    _sessionId: string,
    _resumeToken: string,
    claimToken: string,
    claimEpochValue?: string,
  ): Promise<ResumeOutcome> {
    this.resumeCalls += 1;
    this.resumeClaims.push({ token: claimToken, epoch: claimEpochValue });
    if (this.resume !== undefined) {
      return this.resume.status === 'granted'
        ? {
            status: 'granted',
            grant: {
              ...this.resume.grant,
              claim_token: claimToken,
              claim_epoch: claimEpochValue ?? this.resume.grant.claim_epoch,
            },
          }
        : this.resume;
    }
    return this.consume.status === 'granted'
      ? {
          status: 'granted',
          grant: {
            ...this.consume.grant,
            claim_token: claimToken,
            claim_epoch: claimEpochValue ?? this.consume.grant.claim_epoch,
          },
        }
      : { status: 'unavailable' };
  }

  async authorizeSession(): Promise<AuthzOutcome> {
    return this.authz;
  }

  async reportClose(sessionId: string, report: SessionCloseReport): Promise<void> {
    void sessionId;
    this.closeReports.push(report);
  }

  async publishPresence(agents: readonly AgentPresence[]): Promise<void> {
    this.presence.push([...agents]);
  }
}

/** Stand-in for the Python PTY agent: it speaks the same framing and echoes STDIN back. */
export class FakePtyAgent {
  readonly stdin: Buffer[] = [];
  readonly terminalResponses: Buffer[] = [];
  readonly opens: Record<string, unknown>[] = [];
  readonly closes: Record<string, unknown>[] = [];
  helloAck: Record<string, unknown> | undefined;
  private readonly socket: TLSSocket;
  private readonly decoder = new FrameDecoder();

  private constructor(socket: TLSSocket) {
    this.socket = socket;
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) this.onFrame(frame.tag, frame.payload);
    });
  }

  static async connect(
    port: number,
    material: { cert: string; key: string },
    hello: Record<string, unknown>
  ): Promise<FakePtyAgent> {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port,
      ca: TEST_CA_CERTIFICATE,
      cert: material.cert,
      key: material.key,
      servername: 'localhost'
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', () => resolve());
      socket.once('error', reject);
    });
    const agent = new FakePtyAgent(socket);
    socket.write(encodeJsonFrame(FRAME_TAGS.AGENT_HELLO, hello));
    return agent;
  }

  emit(data: string): void {
    this.socket.write(encodeDataFrame(FRAME_TAGS.STDOUT, SESSION_ID, Buffer.from(data, 'utf8')));
  }

  exit(exitCode: number): void {
    this.socket.write(encodeJsonFrame(FRAME_TAGS.CLOSED, {
      session_id: SESSION_ID, exit_code: exitCode, signal: null, reason: 'exited'
    }));
  }

  destroy(): void {
    this.socket.destroy();
  }

  private onFrame(tag: number, payload: Buffer): void {
    if (tag === FRAME_TAGS.HELLO_ACK) {
      this.helloAck = decodeJsonFrame(payload);
      return;
    }
    if (tag === FRAME_TAGS.PING) {
      this.socket.write(encodeFrame(FRAME_TAGS.PONG));
      return;
    }
    if (tag === FRAME_TAGS.OPEN) {
      const open = decodeJsonFrame(payload);
      this.opens.push(open);
      this.socket.write(encodeJsonFrame(FRAME_TAGS.OPEN_OK, { session_id: open.session_id, pid: 4242 }));
      return;
    }
    if (tag === FRAME_TAGS.STDIN) {
      const data = decodeDataFrame(payload);
      this.stdin.push(data.data);
      // A real PTY echoes what was typed; that is how the operator sees their own keystrokes.
      this.socket.write(encodeDataFrame(FRAME_TAGS.STDOUT, data.sessionId, data.data));
      return;
    }
    if (tag === FRAME_TAGS.TERMINAL_RESPONSE) {
      const data = decodeDataFrame(payload);
      this.terminalResponses.push(data.data);
      return;
    }
    if (tag === FRAME_TAGS.CLOSE) this.closes.push(decodeJsonFrame(payload));
  }
}

export interface Harness {
  readonly browserPort: number;
  readonly agentPort: number;
  readonly leg: AgentLeg;
  readonly presenceChanges: { count: number };
  readonly gateway: ScriptedGateway;
  readonly sessions: SessionManager;
  readonly registryFile: string;
  writeRegistry(agents: readonly Record<string, unknown>[]): Promise<void>;
  close(): Promise<void>;
}

export const harnesses: Harness[] = [];

export async function startHarness(overrides: Partial<SessionLimits> = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-relay-'));
  const registryFile = join(directory, 'pty_agent_identities.json');
  const writeRegistry = async (agents: readonly Record<string, unknown>[]): Promise<void> => {
    await writeFile(registryFile, JSON.stringify({ version: 1, agents }), 'utf8');
  };
  await writeRegistry([{
    fingerprint_sha256: AGENT_FINGERPRINT,
    tenant_id: 'Steven',
    alias: 'jarvis',
    expires_at: new Date(Date.now() + 3_600_000).toISOString()
  }]);
  const gateway = new ScriptedGateway();
  const sessions = new SessionManager({
    gateway,
    limits: {
      idleTimeoutMs: 60_000,
      outputRateBytesPerSec: 262_144,
      scrollbackBytes: 4_096,
      maxSessions: 4,
      authzIntervalMs: 60_000,
      authzGraceMs: 60_000,
      openTimeoutMs: 2_000,
      ...overrides
    }
  });
  const agentServer = createAgentTlsServer({
    cert: TEST_SERVER_CERTIFICATE, key: TEST_SERVER_PRIVATE_KEY, ca: TEST_CA_CERTIFICATE
  });
  const presenceChanges = { count: 0 };
  const leg = new AgentLeg({
    server: agentServer,
    registryFile,
    onChange: () => {
      presenceChanges.count += 1;
    }
  });
  const browserServer = createBrowserHttpsServer({
    cert: TEST_SERVER_CERTIFICATE, key: TEST_SERVER_PRIVATE_KEY, clientCa: TEST_CA_CERTIFICATE
  });
  const browser = new BrowserLeg({
    server: browserServer, relayInstanceId: RELAY_INSTANCE_ID,
    consoleCommonNames: ['console'], gateway, agents: leg, sessions,
    attachTimeoutMs: 300, claimRecoveryWindowMs: 50,
  });
  await Promise.all([
    new Promise<void>((resolve) => agentServer.listen(0, '127.0.0.1', () => resolve())),
    new Promise<void>((resolve) => browserServer.listen(0, '127.0.0.1', () => resolve()))
  ]);
  const harness: Harness = {
    browserPort: (browserServer.address() as AddressInfo).port,
    agentPort: (agentServer.address() as AddressInfo).port,
    leg,
    presenceChanges,
    gateway,
    sessions,
    registryFile,
    writeRegistry,
    close: async () => {
      sessions.closeAll(CLOSE_CODES.going_away, 'test_teardown');
      await browser.close();
      await leg.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
  harnesses.push(harness);
  return harness;
}

export interface BrowserClient {
  readonly socket: WebSocket;
  readonly text: Record<string, unknown>[];
  readonly binary: Buffer[];
  readonly closes: { code: number; reason: string }[];
}

export async function connectConsole(
  port: number,
  material: { cert: string; key: string } = { cert: TEST_CONSOLE_CERTIFICATE, key: TEST_CONSOLE_PRIVATE_KEY },
  origin = `https://localhost:${port}`
): Promise<BrowserClient> {
  // Dialled by name so SNI and hostname verification match the fixture SAN, as nginx would.
  const socket = new WebSocket(`wss://localhost:${port}${browserWebSocketPath(RELAY_INSTANCE_ID)}`, {
    ca: TEST_CA_CERTIFICATE,
    cert: material.cert,
    key: material.key,
    origin
  });
  const client: BrowserClient = { socket, text: [], binary: [], closes: [] };
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) client.binary.push(Buffer.from(data));
    else client.text.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  socket.on('close', (code: number, reason: Buffer) => client.closes.push({ code, reason: reason.toString() }));
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return client;
}

export function attach(client: BrowserClient, overrides: Record<string, unknown> = {}): void {
  client.socket.send(JSON.stringify({
    type: 'attach', session_id: SESSION_ID, ticket: 'opaque-ticket', cols: 120, rows: 40, ...overrides
  }));
}

export function resume(client: BrowserClient, overrides: Record<string, unknown> = {}): void {
  client.socket.send(JSON.stringify({
    type: 'resume', session_id: SESSION_ID, resume_token: 'r'.repeat(100),
    prior_claim_token: CLAIM_TOKEN, prior_claim_epoch: '1',
    after_bytes: 0, cols: 120, rows: 40, ...overrides,
  }));
}
