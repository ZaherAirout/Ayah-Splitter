;;
;; Domain:     drrobot.ai.
;; Exported:   2026-04-09 09:27:20
;;
;; This file is intended for use for informational and archival
;; purposes ONLY and MUST be edited before use on a production
;; DNS server.  In particular, you must:
;;   -- update the SOA record with the correct authoritative name server
;;   -- update the SOA record with the contact e-mail address information
;;   -- update the NS record(s) with the authoritative name servers for this domain.
;;
;; For further information, please consult the BIND documentation
;; located on the following website:
;;
;; http://www.isc.org/
;;
;; And RFC 1035:
;;
;; http://www.ietf.org/rfc/rfc1035.txt
;;
;; Please note that we do NOT offer technical support for any use
;; of this zone data, the BIND name server, or any other third-party
;; DNS software.
;;
;; Use at your own risk.
;; SOA Record
drrobot.ai	3600	IN	SOA	dalary.ns.cloudflare.com. dns.cloudflare.com. 2052739344 10000 2400 604800 3600

;; NS Records
drrobot.ai.	86400	IN	NS	dalary.ns.cloudflare.com.
drrobot.ai.	86400	IN	NS	roman.ns.cloudflare.com.

;; A Records
drrobot.ai.	1	IN	A	46.30.215.182 ; cf_tags=cf-proxied:true
qssh.drrobot.ai.	1	IN	A	46.30.211.192 ; cf_tags=cf-proxied:false

;; CNAME Records
www.drrobot.ai.	1	IN	CNAME	drrobot.ai. ; cf_tags=cf-proxied:true

;; MX Records
drrobot.ai.	1	IN	MX	10 mx4.pub.mailpod14-cph3.one.com.
drrobot.ai.	1	IN	MX	10 mx3.pub.mailpod14-cph3.one.com.
drrobot.ai.	1	IN	MX	10 mx1.pub.mailpod14-cph3.one.com.
drrobot.ai.	1	IN	MX	10 mx2.pub.mailpod14-cph3.one.com.

;; SRV Records
_caldavs._tcp.drrobot.ai.	1	IN	SRV	0 1 443 caldav.one.com.

;; TXT Records
drrobot.ai.	1	IN	TXT	"v=spf1 include:_custspf.one.com ~all"
