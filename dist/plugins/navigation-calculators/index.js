/* ===========================================================================
   Navigation Calculators — bundled first-party Skipi plugin (runtime template)
   ---------------------------------------------------------------------------
   ONE plugin that bundles many calculators as sub-programs.

   Registers:
     window.SkipiPlugins["navigation-calculators"] = { manifest, mount, unmount }

   mount(container, hostApi):
     - renders a categorized LAUNCHER of sub-programs into `container`
     - tapping a card opens that calculator in the same container (with a Back bar)
   unmount():
     - removes the iframe, listeners, theme subscription and empties the container

   Each legacy calculator (2004 NGA-style form + inline JS) is wrapped verbatim
   inside an OPAQUE sandboxed iframe (sandbox="allow-scripts allow-modals
   allow-forms", NO allow-same-origin). The legacy code therefore physically
   cannot reach the network, storage, cookies or the host page. A small shim
   redirects window.open() popups (e.g. Great Circle full track) to an inline
   panel, and a replacement stylesheet stands in for the missing formcatalog.css.

   The manifest, category list and calculator bodies are injected by build.js
   (see src/build.js) in place of the three placeholders in the lines below.
   =========================================================================== */
(function () {
  'use strict';

  var KEY = 'navigation-calculators';
  var manifest = {"id":"app.skipi.plugins.navigation-calculators","slug":"navigation-calculators","name":"Navigation Calculators","version":"0.1.0","developer":"Tymur Rudov / Skipi","kind":"utility","category":"navigation_tools","distribution":{"mode":"bundled_first_party","bundled":true,"remote_code":false},"hosts":["seafarer","onboard"],"entrypoints":{"ui":"index.js","style":"index.css"},"permissions":["local_storage"],"capabilities":{"network":"none","documents":"none","account":"none","analytics":"none","server_upload":false},"safety":{"certified_equipment":false,"requires_disclaimer":true,"disclaimer":"Training and planning aid only. Always verify results against official tables, publications and approved navigation equipment before use."}};
  var CATEGORIES = [{"key":"sailing","title":"Sailing & Courses","titleRu":"Плавание и курсы"},{"key":"astro","title":"Celestial & Sextant","titleRu":"Астрономия и секстан"},{"key":"meteo","title":"Barometer & Weather","titleRu":"Барометр и метео"},{"key":"reference","title":"Reference","titleRu":"Справочники"},{"key":"misc","title":"Other","titleRu":"Прочее"}];
  var CALCULATORS = [{"slug":"latlong","title":"Latitude & Longitude Factors","titleRu":"Факторы широты и долготы","category":"sailing","type":"wrapped","desc":"Change of latitude per unit longitude and vice versa.","descRu":"Изменение широты на единицу долготы и наоборот.","body":"<SCRIPT LANGUAGE=\"JavaScript\">\r\n<!-- Hide JavaSript from non-supportive browsers\r\n\r\n  function fclear(form)\r\n  {\r\n     form.lat.value = \"\"\r\n     form.azimuth.value = \"\"\r\n     form.latitude.value = \"\"\r\n     form.longitude.value = \"\"\r\n  }\r\n\r\n  function compute(obj)\r\n  {\r\n     obj.latitude.value = Math.cos( (obj.lat.value * Math.PI)/180 ) *\r\n\t\t\t\t\t\t\tMath.tan( (obj.azimuth.value * Math.PI)/180 );\r\n     \r\n     obj.longitude.value = (1/Math.cos((obj.lat.value*Math.PI)/180)) *\r\n\t\t\t\t\t\t\t(1/Math.tan((obj.azimuth.value*Math.PI)/180));\r\n  }\r\n// End hide JavaScript -->\r\n</SCRIPT>\r\n\r\n<form name=\"evalForm\">\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\">\r\n\t<tr>\r\n\t\t<td style=\"border: 2px solid #cccccc; background-color: #eeeeee; padding: 5px\" nowrap>\r\n\t\t\tLatitude and Longitude Factors\r\n\t\t</td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\" height=\"100\" class=\"nga-queryRow\">\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tLatitude:\r\n\t\t</td>\t\r\n\t\t<td width=\"300\" align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"lat\" id=\"lat\" size=\"10\" maxlength=\"10\" value=\"\"> (degrees)\r\n\t\t\t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tAzimuth:\r\n\t\t</td>\t\r\n\t\t<td width=\"300\" align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"azimuth\" id=\"azimuth\" size=\"10\" maxlength=\"10\" value=\"\"> (degrees)\r\n\t\t\t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\" class=\"nga-querySubmitRow\">\r\n\t<tr>\r\n\t\t<td align=\"right\">\r\n\t\t\t<input type=\"button\" value=\"Calculate\" onclick=\"compute(this.form)\">&nbsp;&nbsp;\r\n\t\t</td>\r\n\t\t<td align=\"right\">\r\n\t\t\t<input type=\"reset\" value=\"Reset\" onclick=\"fclear(document.evalForm)\">&nbsp;&nbsp;\r\n\t\t</td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\" class=\"nga-queryRow\">\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tThe Change of Latitude for a Unit Change in Longitude:\r\n\t\t</td>\t\r\n\t\t<td align=\"left\" class=\"nga-queryValueCell\">\r\n\t\t\t<input type=\"text\" name=\"latitude\" id=\"latitude\" size=\"10\" maxlength=\"10\" value=\"\">\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tThe Change of Longitude for a Unit Change in Latitude:\r\n\t\t</td>\t\r\n\t\t<td align=\"left\" class=\"nga-queryValueCell\">\r\n\t\t\t<input type=\"text\" name=\"longitude\" id=\"longitude\" size=\"10\" maxlength=\"10\" value=\"\">\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n</table>\r\n\r\n</form>"},{"slug":"speed","title":"Speed, Time & Distance","titleRu":"Скорость, время, расстояние","category":"sailing","type":"wrapped","desc":"Measured-mile speed and speed/time/distance triangle.","descRu":"Скорость на мерной миле и треугольник скорость/время/расстояние.","body":"<SCRIPT LANGUAGE=JavaScript>\r\n<!-- Hide JavaScript from non-supportive browsers\r\n\r\n  function fclear(form)\r\n   {\r\n     form.timesec.value = \"\"\r\n     form.speedmile.value = \"\"\r\n   }\r\n\r\n  function fclear2(form)\r\n   {\r\n     form.speed.value = \"\"\r\n     form.minute.value = \"\"\r\n     form.speedmile.value =\"\"\r\n   }\r\n\r\n  function speedcomp(obj)\r\n {\r\n     obj.speedmile.value = 3600/obj.timesec.value\r\n  }\r\n  function distcomp(obj)\r\n  {\r\n     if (obj.speed.value == \"\") \r\n\tobj.speed.value = (60*obj.distance.value)/obj.minute.value;\r\n     else if (obj.distance.value == \"\")\r\n\tobj.distance.value = (obj.speed.value*obj.minute.value)/60;\r\n     else if (obj.minute.value == \"\")\r\n\tobj.minute.value = (60*obj.distance.value)/obj.speed.value;\r\n  }\r\n// End Hide -->\r\n</SCRIPT>\r\n\r\n<form name=\"evalForm\">\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\">\r\n\t<tr>\r\n\t\t<td style=\"border: 2px solid #cccccc; background-color: #eeeeee; padding: 5px\" nowrap>\r\n\t\t\tSpeed for Measured Mile\r\n\t\t</td>\r\n\t</tr>\r\n</table>\r\n\r\n<br><br>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\">\r\n\t<tr>\r\n\t\t<td style=\"border: 2px solid #cccccc; background-color: #eeeeee; padding: 5px\" nowrap>\r\n\t\t\tSpeed for a Measured Mile <br>\r\n\t\t\tGiven the Time in Seconds, Compute the Speed in Knots \r\n\t\t</td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\" height=\"100\" class=\"nga-queryRow\">\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tElapsed time in seconds:\r\n\t\t</td>\t\r\n\t\t<td width=\"300\" align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"timesec\" id=\"timesec\" size=\"10\" maxlength=\"10\" value=\"\">\r\n\t\t\t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\" class=\"nga-querySubmitRow\">\r\n\t<tr>\r\n\t\t<td align=\"right\">\r\n\t\t\t<input type=\"button\" value=\"Calculate\" onclick=\"speedcomp(this.form)\">&nbsp;&nbsp;\r\n\t\t</td>\r\n\t\t<td align=\"right\">\r\n\t\t\t<input type=\"reset\" value=\"Reset\" onclick=\"fclear(document.evalForm)\">&nbsp;&nbsp;\r\n\t\t</td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\" class=\"nga-queryRow\">\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tSpeed in knots:\r\n\t\t</td>\t\r\n\t\t<td width=\"300\" align=\"left\" class=\"nga-queryValueCell\">\r\n\t\t\t<input type=\"text\" name=\"speedmile\" id=\"speedmile\" size=\"10\" maxlength=\"10\" value=\"\">\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n</table>\r\n\r\n<br><br>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\">\r\n\t<tr>\r\n\t\t<td style=\"border: 2px solid #cccccc; background-color: #eeeeee; padding: 5px\" nowrap>\r\n\t\t\tSpeed, Time and Distance <br>\r\n\t\t\tGiven Two Values, Compute the Third: \r\n\t\t</td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\" height=\"100\" class=\"nga-queryRow\">\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tSpeed in knots:\r\n\t\t</td>\t\r\n\t\t<td width=\"300\" align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"speed\" id=\"speed\" size=\"10\" maxlength=\"10\" value=\"\">\r\n\t\t\t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tElapsed time in minutes:\r\n\t\t</td>\t\r\n\t\t<td width=\"300\" align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"minute\" id=\"minute\" size=\"10\" maxlength=\"10\" value=\"\">\r\n\t\t\t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tDistance in nautical miles:\r\n\t\t</td>\t\r\n\t\t<td width=\"300\" align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"distance\" id=\"distance\" size=\"10\" maxlength=\"10\" value=\"\">\r\n\t\t\t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"500\" class=\"nga-querySubmitRow\">\r\n\t<tr>\r\n\t\t<td align=\"right\">\r\n\t\t\t<input type=\"button\" value=\"Calculate\" onclick=\"distcomp(this.form)\">&nbsp;&nbsp;\r\n\t\t</td>\r\n\t\t<td align=\"right\">\r\n\t\t\t<input type=\"reset\" value=\"Reset\" onclick=\"fclear(document.evalForm)\">&nbsp;&nbsp;\r\n\t\t</td>\r\n\t</tr>\r\n</table>\r\n\r\n</form>"},{"slug":"gcsail","title":"Great Circle Sailing","titleRu":"Дуга большого круга","category":"sailing","type":"wrapped","desc":"Initial course, distance, vertex and way points.","descRu":"Начальный курс, расстояние, вершина и путевые точки.","body":"<SCRIPT LANGUAGE=\"JavaScript\">\r\n\r\n<!-- Hide JavaScript from non-supportive browsers \r\n\r\nfunction dms2dd(deg_in, min_in, sec_in, sign_in)\r\n  {\r\n\tdeg = parseFloat(Math.abs(deg_in));\r\n\tmin = parseFloat(Math.abs(min_in));\r\n      sec = parseFloat(Math.abs(sec_in));\r\n\tif (isNaN(deg))\r\n\t\tdeg = 0;\r\n\tif (isNaN(min))\r\n\t\tmin = 0;\r\n      if (isNaN(sec))\r\n            sec = 0;\r\n\r\n\tangle = deg + (min/60.) + (sec/3600.);\r\n\r\n      sign = 1;\r\n\r\n\tif (sign_in == \"South\" || sign_in == \"West\")\r\n\t\t{sign = -1};\r\n\r\n\tangle = angle * sign\r\n\r\n\treturn(angle);\r\n  }\r\n\r\n\r\nfunction deg2rad(deg)\r\n  {\r\n\tconv_factor = (2.0 * Math.PI)/360.0;\r\n\treturn(deg * conv_factor);\r\n  }\r\n\r\nfunction rad2deg(rad)\r\n  {\r\n\tconv_factor = 360.0/(2.0 * Math.PI);\r\n\treturn(rad * conv_factor);\r\n  }\r\n\r\nfunction valid(input, min, max, msg)\r\n  {\r\n      msg = msg + \"field contains invalid data: \" + input.value;\r\n      floatValue = parseFloat(input.value);\r\n      if (input.value == null || input.value.length == 0)\r\n         {\r\n           input.value = 0;\r\n           floatValue = 0;\r\n           return true;\r\n         }\r\n      in_string = input.value;\r\n      for (i = 0; i < in_string.length; i++)\r\n         {\r\n           ch = in_string.charAt(i)\r\n           if ((ch < \"0\" || ch > \"9\") && ch != \".\")    \r\n      \r\n            {\r\n              alert(msg);\r\n              return false;\r\n            }\r\n         }\r\n      if (floatValue < min || floatValue > max)\r\n         {\r\n           alert(msg + \" not within range [\" + min + \"..\" + max + \"]\");\r\n           return false;\r\n         }\r\n     \r\n      return true;\r\n  }\r\n\r\n\tfunction swapsign(sign_in, latlon)\r\n  \t{  \r\n    \tif (latlon.value == \"1\") {\r\n\t\t\tif (sign_in.value == \"North\")\r\n\t\t\t\tsign_in.value = \"South\";\r\n\t\t\telse \r\n\t\t\t\tsign_in.value = \"North\";\r\n      \t} else {\r\n\t\t\tif (sign_in.value == \"East\")\r\n\t\t\t\tsign_in.value = \"West\";\r\n\t\t\telse \r\n            \tsign_in.value = \"East\"; \r\n      \t}\r\n      \treturn sign_in.value;\r\n  \t}\r\n\r\nfunction fclear(form)\r\n  {\r\n\tform.lat1_deg.value = \"\"\r\n      form.lat1_min.value = \"\"\r\n      form.lat1_sec.value = \"\"\r\n      form.lat1_sign.value = \"North\"\r\n      form.lon1_deg.value = \"\"\r\n      form.lon1_min.value = \"\"\r\n      form.lon1_sec.value = \"\"\r\n      form.lon1_sign.value = \"East\"\r\n      form.lat2_deg.value = \"\"\r\n      form.lat2_min.value = \"\"\r\n      form.lat2_sec.value = \"\"\r\n      form.lat2_sign.value = \"North\"\r\n      form.lon2_deg.value = \"\"\r\n      form.lon2_min.value = \"\"\r\n      form.lon2_sec.value = \"\"\r\n      form.lon2_sign.value = \"East\"\r\n      form.course.value = \"\"\r\n      form.dist.value = \"\"\r\n  }\r\n\r\n\r\n\r\n// Main function for computing Great Circle course and distance\r\nfunction compute(form)\r\n  {\r\n   // Set initial value of the vertex to 0,0\r\n\r\n   Lv = 0;\r\n   Lov = 0;\r\n\r\n   // Get input values, parse them for float values and check validity \r\n\r\n   if (!valid(form.lat1_deg,0,89,\"Initial Latitude degree \"))\r\n          {form.dist.value = \"Error\"; return;}      \r\n   if (!valid(form.lat1_min,0,59.9999999,\"Initial Latitude minute \"))\r\n          {form.dist.value = \"Error\"; return;}\r\n   if (!valid(form.lat1_sec,0,59.9999999,\"Initial Latitude second \"))\r\n          {form.dist.value = \"Error\"; return;}\r\n   if (!valid(form.lon1_deg,0,180,\"Initial Longitude degree \"))\r\n          {form.dist.value = \"Error\"; return;}\r\n   if (!valid(form.lon1_min,0,59.9999999,\"Initial Longitude minute \")) \r\n          {form.dist.value = \"Error\"; return;}\r\n   if (!valid(form.lon1_sec,0,59.9999999,\"Initial Longitude second \")) \r\n          {form.dist.value = \"Error\"; return;}\r\n   if (!valid(form.lat2_deg,0,89,\"Final Latitude degree \")) \r\n          {form.dist.value = \"Error\"; return;}\r\n   if (!valid(form.lat2_min,0,59.9999999,\"Final Latitude minute \"))\r\n          {form.dist.value = \"Error\"; return;}\r\n   if (!valid(form.lat2_sec,0,59.9999999,\"Final Latitude second \"))\r\n          {form.dist.value = \"Error\"; return;}\r\n   if (!valid(form.lon2_deg,0,180,\"Final Longitude degree \")) \r\n          {form.dist.value = \"Error\"; return;}\r\n   if (!valid(form.lon2_min,0,59.9999999,\"Final Longitude minute \"))\r\n          {form.dist.value = \"Error\"; return;}\r\n   if (!valid(form.lon2_sec,0,59.9999999,\"Final Longitude second \"))\r\n          {form.dist.value = \"Error\"; return;}\r\n   lat1_deg = parseFloat(form.lat1_deg.value);\r\n   lat1_min = parseFloat(form.lat1_min.value);\r\n   lat1_sec = parseFloat(form.lat1_sec.value);\r\n   lon1_deg = parseFloat(form.lon1_deg.value);\r\n   lon1_min = parseFloat(form.lon1_min.value);\r\n   lon1_sec = parseFloat(form.lon1_sec.value);\r\n   lat2_deg = parseFloat(form.lat2_deg.value);\r\n   lat2_min = parseFloat(form.lat2_min.value);\r\n   lat2_sec = parseFloat(form.lat2_sec.value);\r\n   lon2_deg = parseFloat(form.lon2_deg.value);\r\n   lon2_min = parseFloat(form.lon2_min.value);\r\n   lon2_sec = parseFloat(form.lon2_sec.value);\r\n   lat1_sign = form.lat1_sign.value\r\n   lat2_sign = form.lat2_sign.value\r\n   lon1_sign = form.lon1_sign.value\r\n   lon2_sign = form.lon2_sign.value\r\n   if ((lat1_sign != \"North\" && lat1_sign != \"South\") ||\r\n       (lat2_sign != \"North\" && lat2_sign != \"South\") ||\r\n       (lon1_sign != \"East\" && lon1_sign != \"West\") ||\r\n       (lon2_sign != \"East\" && lon2_sign != \"West\") )\r\n        {\r\n           alert(\"Check hemisphere value\");\r\n           form.dist.value = \"Error\";\r\n           return;\r\n        }\r\n\r\n   // Get angles & convert to radians\r\n   lat1 = deg2rad(dms2dd(lat1_deg, lat1_min, lat1_sec, lat1_sign));\r\n   lat2 = deg2rad(dms2dd(lat2_deg, lat2_min, lat2_sec, lat2_sign));\r\n   lon1 = dms2dd(lon1_deg, lon1_min, lon1_sec, lon1_sign);\r\n   lon2 = dms2dd(lon2_deg, lon2_min, lon2_sec, lon2_sign);\r\n\r\n   if (lat1 == lat2 && lon1 == lon2)\r\n      {form.course.value = \"error\"; form.dist.value = \"Same Point\"; return;}\r\n\r\n   dlon = lon2 - lon1;\r\n   if (dlon > 180)\r\n   \tdlon = dlon - 360;\r\n   if (dlon < -180)\r\n   \tdlon = 360 + dlon;\r\n   rdlon = deg2rad(dlon);\r\n\r\n   // Calculate Distance \r\n\r\n   cosdist = (Math.sin(lat1)*Math.sin(lat2) + \r\n              Math.cos(lat1)*Math.cos(lat2)*Math.cos(rdlon));\r\n   rdist = Math.acos(cosdist)\r\n\r\n\r\n   // Convert Distance to Nautical Miles\r\n   form.dist.value = Math.abs(rad2deg(rdist) * 60.)\r\n\r\n\r\n   // Calculate Course\r\n\r\n   tancourse = Math.sin(rdlon) /((Math.cos(lat1)*Math.tan(lat2)) -\r\n                 (Math.sin(lat1)*Math.cos(rdlon)))\r\n\r\n   course = rad2deg(Math.atan(tancourse));\r\n\r\n   if (dlon == 0 && lat1 > lat2)\r\n      course = 180;\r\n\r\n   if (dlon < 0 && course < 0)\r\n      {course = course + 360}\r\n   else \r\n      {if ((dlon < 0 && course > 0) || (dlon > 0 && course < 0))\r\n         {course = course + 180}\r\n      }\r\n\r\n   form.course.value = course\r\n\r\n// Get latitude of the vertex\r\n\r\n   cosLv = Math.cos(lat1) * Math.sin(deg2rad(course));\r\n   Lv = rad2deg(Math.acos(cosLv));\r\n \r\n   if (course == 0 || course == 180)\r\n      Lv = 90;\r\n   if (Lv > 90) \r\n      Lv = 180 - Lv;\r\n   if (lat1 < 0)\r\n      Lv = -Lv;\r\n\r\n   // Get longitude of vertex\r\n\r\n   if (Lv != 0)\r\n   {\r\n   sinDLov = Math.cos(deg2rad(course))/Math.sin(deg2rad(Lv));\r\n   Dlov = rad2deg(Math.asin(sinDLov));\r\n\r\n   if (course > 180)\r\n      Dlov = -Dlov;\r\n \r\n   Lov = Dlov + lon1;\r\n   }\r\n   else\r\n   {\r\n    Lov = 0;\r\n   }\r\n\r\n  }\r\n\r\n// Function to compute way point latitude from waypoint longitude\r\n\r\nfunction waylat(form)\r\n  {\r\n   // Get input values, parse them for float values\r\n\r\n   if (!valid(form.wlon_deg,0,180,\"Way Point Longitude degree \"))\r\n        {form.wlat_deg.value = \"Error\"; return;}\r\n   if (!valid(form.wlon_min,0,59.9999999,\"Way Point Longitude minute \"))\r\n        {form.wlat_deg.value = \"Error\"; return;}\r\n   if (!valid(form.wlon_sec,0,59.9999999,\"Way Point Longitude second \"))\r\n        {form.wlat_deg.value = \"Error\"; return;}\r\n   wlon_deg = parseFloat(form.wlon_deg.value);\r\n   wlon_min = parseFloat(form.wlon_min.value);\r\n   wlon_sec = parseFloat(form.wlon_sec.value);\r\n\r\n   if (Lv == 90 || Lv == -90)\r\n       {\r\n          form.wlat_deg.value = \"error\";\r\n          form.wlat_min.value = \"Polar\";\r\n          form.wlat_sec.value = \"track\";\r\n          return;\r\n       }\r\n   wlon_sign = form.wlon_sign.value;\r\n   if (wlon_sign != \"East\" && wlon_sign != \"West\")\r\n      {\r\n       alert(\"Check hemisphere value\");\r\n       form.wlat_deg.value = \"Error\";\r\n       return;\r\n      }\r\n\r\n   // Get way point longitude\r\n\r\n   wlon = dms2dd(wlon_deg, wlon_min, wlon_sec, wlon_sign);\r\n\r\n   // Compute way point latitude\r\n\r\n   Dlovx = wlon - Lov;\r\n   tanwaylat = Math.cos(deg2rad(Dlovx)) * Math.tan(deg2rad(Lv));\r\n   way_lat = rad2deg(Math.atan(tanwaylat));\r\n\r\n   form.wlat_sign.value = \"North\";\r\n   if (way_lat < 0)\r\n   {\r\n      form.wlat_sign.value = \"South\";\r\n   }\r\n\r\n   way_lat = Math.abs(way_lat);\r\n   waylat_deg = Math.floor(way_lat);\r\n   way_lat = (way_lat - waylat_deg) * 60;\r\n   waylat_min = Math.floor(way_lat);\r\n   waylat_sec = (way_lat - waylat_min) * 60;\r\n   waylat_sec = (Math.floor(waylat_sec*1000))/1000;\r\n   form.wlat_deg.value = waylat_deg;\r\n   form.wlat_min.value = waylat_min;\r\n   form.wlat_sec.value = waylat_sec; \r\n  }\r\n\r\n//** Function to calculate the whole Great Circle Track at 5-degree longitude intervals **//\r\nfunction waypoints(form)\r\n{\r\n   msgWindow=window.open(\"\",\"msgWindow\",\"toolbar=no,status=no,menubar=yes,scrollbars=yes,width=550,height=400\")\r\n   msgWindow.document.open()\r\n   msgWindow.document.write(\"<html><head><title>Great Circle Sailing - Full Track</title></head>\")\r\n   msgWindow.document.write(\"<body>\")   \r\n   msgWindow.document.write(\"<h3>Entire Great Circle Track at 5-degree Longitude Intervals </h3><br>\")\r\n    msgWindow.document.write(\"Please close this window to return to parent page<br><br>\")\r\n   \r\n    var wplon = 0\r\n    var wplat = 0\r\n    var wprlon = 0\r\n    var wprlat = 0\r\n    var count = -180    \r\n    var z = 0\r\n    var wpsign = 0\r\n    var wpdeg = 0\r\n    var wpmin = 0\r\n    var wpalat = 0\r\n    msgWindow.document.write(\"<table>\")\r\n    while (count <= 180)\r\n    {\r\n    \r\n    msgWindow.document.write(\"<tr><td>\")\r\n    msgWindow.document.write(\"W. P. Long. = <td>\")\r\n    msgWindow.document.write(Math.abs(count))\r\n    msgWindow.document.write(\"<td>\")\r\n    if (count < 0)\r\n    {msgWindow.document.write(\" W <td>\")}\r\n    if (count > 0)\r\n    {msgWindow.document.write(\" E <td>\")}\r\n    if (count == 0)\r\n    {msgWindow.document.write(\" <td>\")}\r\n    msgWindow.document.write(\" - W. P. Lat. = <td>\")\r\n    wplon = count\r\n    if (wplon < 0)\r\n    {wplon = wplon + 360}\r\n    Dlovx = wplon - Lov\r\n    tanwaylat = Math.cos(deg2rad(Dlovx)) * Math.tan(deg2rad(Lv));\r\n    wplat = rad2deg(Math.atan(tanwaylat));\r\n    wpalat = Math.abs(wplat)\r\n    wpsign = 0    \r\n    if (wplat != 0)    \r\n    {wpsign = wplat/wpalat}\r\n    wpdeg = Math.floor(wpalat)\r\n    wpalat = (wpalat-wpdeg)*60\r\n    wpmin = Math.floor(wpalat)\r\n    wpsec = (wpalat-wpmin)*60\r\n    wpsec = (Math.floor(wpsec*1000))/1000\r\n    wpdeg = wpdeg\r\n    msgWindow.document.write(wpdeg)\r\n    msgWindow.document.write(\" \")\r\n    msgWindow.document.write(wpmin)\r\n    msgWindow.document.write(\" \")\r\n    msgWindow.document.write(wpsec)\r\n    if (wpsign < 0)\r\n    {msgWindow.document.write(\" S </td>\")}\r\n   if (wpsign == 0)\r\n    {msgWindow.document.write(\" </td>\")}\r\n    if (wpsign > 0)\r\n    {msgWindow.document.write(\" N </td>\")}\r\n    msgWindow.document.writeln(\"</tr>\")\r\n    count = count + 5\r\n    }\r\n    msgWindow.document.write(\"</table>\")\r\n    msgWindow.document.write(\"</body></html>\")\r\n    msgWindow.document.close()\r\n\r\n}\r\n<!-- end hide JavaScript from non-supportive browsers -->\r\n\r\n</SCRIPT>\r\n\r\n<form name=\"evalForm\">\r\n  <input type=\"hidden\" name=\"one\" value=\"1\">\r\n  <input type=\"hidden\" name=\"two\" value=\"2\">\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"600\">\r\n\t<tr>\r\n\t\t<td style=\"border: 2px solid #cccccc; background-color: #eeeeee; padding: 5px\" nowrap>\r\n\t\t\tGreat Circle Sailing\r\n\t\t</td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td style=\"border: 2px solid #cccccc; background-color: #eeeeee; padding: 5px\">\r\n\t\t\tNote: Enter degrees, minutes and decimal minutes or degrees, \r\n\t\t\tminutes, seconds and decimal seconds\r\n\t\t</td>\r\n\t</tr>\r\n</table>\r\n\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"600\" height=\"100\" class=\"nga-queryRow\">\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td colspan=\"3\" class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tOrigin (Initial Position)\r\n\t\t</td>\t\r\n\t\t<td width=\"3\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tLatitude:\r\n\t\t</td>\t\r\n\t\t<td align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"lat1_deg\" size=\"3\"> degrees\r\n        \t\t\t\t<input type=\"text\" name=\"lat1_min\" size=\"7\"> minutes\r\n        \t\t\t\t<input type=\"text\" name=\"lat1_sec\" size=\"7\"> seconds\r\n        \t\t\t\t<input type=\"text\" name=\"lat1_sign\" id=\"lat1_sing\" value=\"North\" size=\"5\">\r\n        \t\t\t\t<input type=\"button\" value=\"N/S\" onclick=\"swapsign(form.lat1_sign, form.one)\">\r\n        \t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tLongitude:\r\n\t\t</td>\t\r\n\t\t<td align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"lon1_deg\" size=\"3\"> degrees\r\n        \t\t\t\t<input type=\"text\" name=\"lon1_min\" size=\"7\"> minutes\r\n        \t\t\t\t<input type=\"text\" name=\"lon1_sec\" size=\"7\"> seconds\r\n        \t\t\t\t<input type=\"text\" name=\"lon1_sign\" value=\"East\" size=\"5\">\r\n        \t\t\t\t<input type=\"button\" value=\"E/W\" onclick=\"swapsign(form.lon1_sign, form.two)\">\r\n        \t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td colspan=\"3\" class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tDestination (Final Position)\r\n\t\t</td>\t\r\n\t\t<td width=\"3\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tLatitude:\r\n\t\t</td>\t\r\n\t\t<td align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"lat2_deg\" size=\"3\"> degrees\r\n        \t\t\t\t<input type=\"text\" name=\"lat2_min\" size=\"7\"> minutes\r\n        \t\t\t\t<input type=\"text\" name=\"lat2_sec\" size=\"7\"> seconds\r\n        \t\t\t\t<input type=\"text\" name=\"lat2_sign\" value=\"North\" size=\"5\">\r\n        \t\t\t\t<input type=\"button\" value=\"N/S\" onclick=\"swapsign(form.lat2_sign, form.one)\">\r\n        \t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tLongitude:\r\n\t\t</td>\t\r\n\t\t<td align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"lon2_deg\" size=\"3\"> degrees\r\n        \t\t\t\t<input type=\"text\" name=\"lon2_min\" size=\"7\"> minutes\r\n        \t\t\t\t<input type=\"text\" name=\"lon2_sec\" size=\"7\"> seconds\r\n        \t\t\t\t<input type=\"text\" name=\"lon2_sign\" value=\"East\" size=\"5\">\r\n        \t\t\t\t<input type=\"button\" value=\"E/W\" onclick=\"swapsign(form.lon2_sign, form.two)\">\r\n        \t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"600\" class=\"nga-querySubmitRow\">\r\n\t<tr>\r\n\t\t<td align=\"center\">\r\n\t\t\t<input type=\"button\" value=\"Calculate\" onclick=\"compute(document.evalForm)\">&nbsp;&nbsp;\r\n\t\t</td>\r\n\t\t<td align=\"center\">\r\n\t\t\t<input type=\"reset\" value=\"Reset\" onclick=\"fclear(document.evalForm)\">&nbsp;&nbsp;\r\n\t\t</td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"600\" class=\"nga-queryRow\">\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tResults:\r\n\t\t</td>\r\n\t</tr>\t\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tInitial Course :\r\n\t\t</td>\r\n\t\t<td align=\"left\" class=\"nga-queryValueCell\">\r\n\t\t\t<input type=\"text\" name=\"course\" size=\"10\"> degrees true\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tGreat Circle Distance :\r\n\t\t</td>\r\n\t\t<td align=\"left\" class=\"nga-queryValueCell\">\r\n\t\t\t<input type=\"text\" name=\"dist\" size=\"10\"> nautical miles\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n</table>\r\n<br><br><br>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"600\">\r\n\t<tr>\r\n\t\t<td style=\"border: 2px solid #cccccc; background-color: #eeeeee; padding: 5px\" nowrap>\r\n\t\t\tGreat Circle Sailing\r\n\t\t</td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td style=\"border: 2px solid #cccccc; background-color: #eeeeee; padding: 5px\" nowrap>\r\n\t\t\tWay Point Calculations\r\n\t\t</td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"600\" height=\"100\" class=\"nga-queryRow\">\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tWay Point Longitude:\r\n\t\t</td>\t\r\n\t\t<td width=\"500\" align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"wlon_deg\" size=\"3\"> degrees\r\n        \t\t\t\t<input type=\"text\" name=\"wlon_min\" size=\"7\"> minutes\r\n        \t\t\t\t<input type=\"text\" name=\"wlon_sec\" size=\"7\"> seconds\r\n        \t\t\t\t<input type=\"text\" name=\"wlon_sign\" value=\"East\" size=\"5\">\r\n        \t\t\t\t<input type=\"button\" value=\"E/W\" onclick=\"swapsign(form.wlon_sign, form.two)\">\r\n        \t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td class=\"nga-queryLabel\" align=\"left\" valign=\"middle\">\r\n\t\t\tWay Point Latitude:\r\n\t\t</td>\t\r\n\t\t<td width=\"500\" align=\"center\" class=\"nga-queryValueCell\">\r\n\t\t\t<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\">\r\n\t\t\t\t<tr>\r\n\t\t\t\t\t<td align=\"left\">\r\n\t\t\t\t\t\t<input type=\"text\" name=\"wlat_deg\" value=\"??\" size=\"3\"> degrees\r\n        \t\t\t\t<input type=\"text\" name=\"wlat_min\" value=\"??\" size=\"7\"> minutes\r\n        \t\t\t\t<input type=\"text\" name=\"wlat_sec\" value=\"??\" size=\"7\"> seconds\r\n        \t\t\t\t<input type=\"text\" name=\"wlat_sign\" value=\"East\" size=\"5\">\r\n        \t\t\t</td>\r\n\t\t\t\t</tr>\r\n\t\t\t</table>\r\n\t\t</td>\r\n\t\t<td width=\"2\"></td>\r\n\t</tr>\r\n\t<tr>\r\n\t\t<td colspan=\"3\" height=\"10\"></td>\r\n\t</tr>\r\n</table>\r\n\r\n<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"600\" class=\"nga-querySubmitRow\">\r\n\t<tr>\r\n\t\t<td align=\"center\">\r\n\t\t\t<input type=\"button\" value=\"Calculate\" onclick=\"waylat(document.evalForm)\">&nbsp;&nbsp;\r\n\t\t</td>\r\n\t\t<td align=\"center\">\r\n\t\t\t<input type=\"reset\" value=\"Calculate Full Track\" onclick=\"waypoints(document.evalForm)\">&nbsp;&nbsp;\r\n\t\t</td>\r\n\t</tr>\r\n</table>\r\n\r\n</form>"},{"slug":"zones","title":"Time Zones","titleRu":"Часовые пояса","category":"reference","type":"wrapped","desc":"Zone descriptions and suffixes reference table.","descRu":"Справочная таблица поясов, описаний и суффиксов.","body":"<form name=\"evalForm\"><table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"300\">\t<tr>\t\t<td style=\"border: 2px solid #cccccc; background-color: #eeeeee; padding: 5px\">\t\t\tTime Zones, Zone Descriptions, and Suffixes\t\t</td>\t</tr></table><table width=\"300\" align=\"left\" border=1>\t<tr align=center>\t\t<th>Zone</th>\t\t<th>ZD</th>\t\t<th>SUFFIX</th>\t</tr>\t\t<tr align=center>\t\t<td>7&frac12;&deg;W. to 7&frac12;&deg;E.</td>\t\t<td>0</td>\t\t<td>Z</td>\t</tr>\t\t<tr align=center>\t\t<td>7&frac12;&deg;E. to 22&frac12;&deg;E.</td>\t\t<td>-1</td>\t\t<td>A</td>\t</tr>\t\t<tr align=center>\t\t<td>22&frac12;&deg;E. to 37&frac12;&deg;E.</td>\t\t<td>-2</td>\t\t<td>B</td>\t</tr>\t\t<tr align=center>\t\t<td>37&frac12;&deg;E. to 52&frac12;&deg;E.</td>\t\t<td>-3</td>\t\t<td>C</td>\t</tr>\t\t<tr align=center>\t\t<td>52&frac12;&deg;E. to 67&frac12;&deg;E.</td>\t\t<td>-4</td>\t\t<td>D</td>\t</tr>\t\t<tr align=center>\t\t<td>67&frac12;&deg;E. to 82&frac12;&deg;E.</td>\t\t<td>-5</td>\t\t<td>E</td>\t</tr>\t\t<tr align=center>\t\t<td>82&frac12;&deg;E. to 97&frac12;&deg;E.</td>\t\t<td>-6</td>\t\t<td>F</td>\t</tr>\t\t<tr align=center>\t\t<td>97&frac12;&deg;E. to 112&frac12;&deg;E.</td>\t\t<td>-7</td>\t\t<td>G</td>\t</tr>\t\t<tr align=center>\t\t<td>112&frac12;&deg;E. to 127&frac12;&deg;E.</td>\t\t<td>-8</td>\t\t<td>H</td>\t</tr>\t\t<tr align=center>\t\t<td>127&frac12;&deg;E. to 142&frac12;&deg;E.</td>\t\t<td>-9</td>\t\t<td>I</td>\t</tr>\t\t<tr align=center>\t\t<td>142&frac12;&deg;E. to 157&frac12;&deg;E.</td>\t\t<td>-10</td>\t\t<td>K</td>\t</tr>\t\t<tr align=center>\t\t<td>157&frac12;&deg;E. to 172&frac12;&deg;E.</td>\t\t<td>-11</td>\t\t<td>L</td>\t</tr>\t\t<tr align=center>\t\t<td>172&frac12;&deg;E. to 180&deg;</td>\t\t<td>-12</td>\t\t<td>M</td>\t</tr>\t\t<tr align=center>\t\t<td>7&frac12;&deg;W. to 22&frac12;&deg;W.</td>\t\t<td>1</td>\t\t<td>N</td>\t</tr>\t\t<tr align=center>\t\t<td>22&frac12;&deg;W. to 37&frac12;&deg;W.</td>\t\t<td>2</td>\t\t<td>O</td>\t</tr>\t\t<tr align=center>\t\t<td>37&frac12;&deg;W. to 52&frac12;&deg;W.</td>\t\t<td>3</td>\t\t<td>P</td>\t</tr>\t\t<tr align=center>\t\t<td>52&frac12;&deg;W. to 67&frac12;&deg;W.</td>\t\t<td>4</td>\t\t<td>Q</td>\t</tr>\t\t<tr align=center>\t\t<td>67&frac12;&deg;W. to 82&frac12;&deg;W.</td>\t\t<td>5</td>\t\t<td>R</td>\t</tr>\t\t<tr align=center>\t\t<td>82&frac12;&deg;W. to 97&frac12;&deg;W.</td>\t\t<td>6</td>\t\t<td>S</td>\t</tr>\t\t<tr align=center>\t\t<td>97&frac12;&deg;W. to 112&frac12;&deg;W.</td>\t\t<td>7</td>\t\t<td>T</td>\t</tr>\t\t<tr align=center>\t\t<td>112&frac12;&deg;W. to 127&frac12;&deg;W.</td>\t\t<td>8</td>\t\t<td>U</td>\t</tr>\t\t<tr align=center>\t\t<td>127&frac12;&deg;W. to 142&frac12;&deg;W.</td>\t\t<td>9</td>\t\t<td>V</td>\t</tr>\t\t<tr align=center>\t\t<td>142&frac12;&deg;W. to 157&frac12;&deg;W.</td>\t\t<td>10</td>\t\t<td>W</td>\t</tr>\t\t<tr align=center>\t\t<td>157&frac12;&deg;W. to 172&frac12;&deg;W.</td>\t\t<td>11</td>\t\t<td>X</td>\t</tr>\t\t<tr align=center>\t\t<td>172&frac12;&deg;W. to 180&deg;</td>\t\t<td>12</td>\t\t<td>Y</td>\t</tr></table align=center></form>"}];

  var SANDBOX = 'allow-scripts allow-modals allow-forms'; // intentionally NO allow-same-origin

  var SAFETY_EN = 'Training and planning aid only. Always verify results against official tables, publications and approved navigation equipment before use.';
  var SAFETY_RU = 'Учебно-вспомогательный инструмент. Всегда сверяйте результат с официальными таблицами, пособиями и штатным навигационным оборудованием.';

  // Replacement for the original (missing) formcatalog.css, injected into each
  // wrapped calculator. Theme variables are prepended per-theme in buildSrcdoc.
  var RESET_CSS = [
    '*{box-sizing:border-box}',
    'html,body{margin:0}',
    'body{background:var(--nc-bg);color:var(--nc-fg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.45;padding:14px}',
    'table{border-collapse:collapse;max-width:100%}',
    'td,th{color:var(--nc-fg);padding:2px 4px;vertical-align:middle}',
    'th{padding:4px 6px}',
    '.nga-queryRow{margin:4px 0}',
    '.nga-queryLabel{color:var(--nc-fg);font-weight:600;padding:6px 10px 6px 0}',
    '.nga-queryValueCell{padding:4px 0}',
    '.nga-querySubmitRow{margin:10px 0}',
    'input[type=text]{background:var(--nc-field);color:var(--nc-fg);border:1px solid var(--nc-border);border-radius:6px;padding:6px 8px;font-size:14px;max-width:100%}',
    'input[type=button],input[type=reset],input[type=submit],button{background:var(--nc-accent);color:#fff;border:1px solid var(--nc-accent);border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;font-size:14px;min-height:40px}',
    'input[type=reset]{background:transparent;color:var(--nc-fg);border-color:var(--nc-border)}',
    'input[type=button]:hover,button:hover{filter:brightness(1.05)}',
    /* override the legacy inline-styled header cells (bg #eeeeee) for theming */
    'td[style*="eeeeee"]{background:var(--nc-head)!important;border-color:var(--nc-border)!important;color:var(--nc-fg)!important;border-radius:6px}',
    '#__skipi_popout__{margin-top:16px;padding:12px;border:1px solid var(--nc-border);border-radius:8px;background:var(--nc-popout);overflow:auto;max-height:55vh}',
    '#__skipi_popout__ table{width:100%}',
    'a{color:var(--nc-accent)}'
  ].join('');

  // Redirect window.open(...) popups to an inline panel inside the iframe.
  var OPEN_SHIM = [
    '(function(){',
    '  function panel(){',
    '    var h=document.getElementById("__skipi_popout__");',
    '    if(!h){h=document.createElement("div");h.id="__skipi_popout__";document.body.appendChild(h);}',
    '    return h;',
    '  }',
    '  window.open=function(){',
    '    var h=panel();',
    '    var doc={',
    '      open:function(){h.innerHTML="";},',
    '      write:function(s){h.insertAdjacentHTML("beforeend",String(s));},',
    '      writeln:function(s){h.insertAdjacentHTML("beforeend",String(s)+"\\n");},',
    '      close:function(){try{h.scrollIntoView({block:"nearest"});}catch(e){}}',
    '    };',
    '    return {document:doc,focus:function(){},close:function(){},closed:false};',
    '  };',
    '})();'
  ].join('\n');

  function themeVars(theme) {
    return theme === 'light'
      ? ':root{--nc-bg:#ffffff;--nc-fg:#111827;--nc-muted:#4b5563;--nc-border:#cbd5e1;--nc-field:#ffffff;--nc-accent:#2563eb;--nc-head:#eef2f7;--nc-popout:#f8fafc;}'
      : ':root{--nc-bg:#0f141f;--nc-fg:#e8edf5;--nc-muted:#9fb0c8;--nc-border:#2c3649;--nc-field:#0b0f17;--nc-accent:#3b82f6;--nc-head:#1a2130;--nc-popout:#131a26;}';
  }

  function buildSrcdoc(calc, theme) {
    return '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<style>' + themeVars(theme) + RESET_CSS + '</style>'
      + '<scr' + 'ipt>' + OPEN_SHIM + '</scr' + 'ipt>'
      + '</head><body>' + calc.body + '</body></html>';
  }

  function normalizeTheme(t) {
    if (!t) return null;
    if (typeof t === 'string') return t.toLowerCase().indexOf('light') >= 0 ? 'light' : 'dark';
    if (typeof t === 'object') {
      if (typeof t.dark === 'boolean') return t.dark ? 'dark' : 'light';
      if (typeof t.isDark === 'boolean') return t.isDark ? 'dark' : 'light';
      var m = t.mode || t.name || t.scheme;
      if (m) return String(m).toLowerCase().indexOf('light') >= 0 ? 'light' : 'dark';
    }
    return null;
  }
  function readHostTheme(hostApi) {
    try { return hostApi && hostApi.theme && hostApi.theme.get ? normalizeTheme(hostApi.theme.get()) : null; }
    catch (e) { return null; }
  }

  function makeStore(hostApi) {
    var hs = hostApi && hostApi.storage, ns = 'navcalc.';
    var hasHost = hs && typeof hs.get === 'function' && typeof hs.set === 'function';
    return {
      get: function (k) { try { return hasHost ? hs.get(ns + k) : localStorage.getItem(ns + k); } catch (e) { return null; } },
      set: function (k, v) { try { hasHost ? hs.set(ns + k, v) : localStorage.setItem(ns + k, v); } catch (e) {} }
    };
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var current = null;

  function createInstance(container, hostApi) {
    var store = makeStore(hostApi);
    var theme = readHostTheme(hostApi) || 'dark';
    var view = 'launcher';     // 'launcher' | 'calc'
    var currentSlug = null;
    var lastOpened = store.get('lastOpened');

    var root, topbar, bodyEl, iframe = null;
    var themeUnsub = null, destroyed = false;
    var listeners = [];
    function on(node, type, fn) { node.addEventListener(type, fn); listeners.push([node, type, fn]); }

    function calcBySlug(slug) {
      for (var i = 0; i < CALCULATORS.length; i++) if (CALCULATORS[i].slug === slug) return CALCULATORS[i];
      return null;
    }
    function catTitle(key) {
      for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].key === key) return CATEGORIES[i];
      return { key: key, title: key, titleRu: key };
    }

    function build() {
      root = el('div', 'skipi-navcalc');
      root.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark');
      topbar = el('div', 'nc-topbar');
      bodyEl = el('div', 'nc-body');
      root.appendChild(topbar);
      root.appendChild(bodyEl);
      container.appendChild(root);
    }

    function renderTopbar() {
      topbar.innerHTML = '';
      if (view === 'launcher') {
        var t = el('div', 'nc-title', 'Navigation Calculators');
        var s = el('div', 'nc-sub', 'Verified offline navigation tools · локально, без сети');
        var wrap = el('div', 'nc-titlewrap'); wrap.appendChild(t); wrap.appendChild(s);
        topbar.appendChild(wrap);
      } else {
        var back = el('button', 'nc-back'); back.type = 'button';
        back.innerHTML = '‹ Back';
        on(back, 'click', closeCalc);
        var c = calcBySlug(currentSlug);
        var ct = el('div', 'nc-title', c ? c.title : '');
        var cs = el('div', 'nc-sub', c ? c.titleRu : '');
        var w2 = el('div', 'nc-titlewrap'); w2.appendChild(ct); w2.appendChild(cs);
        topbar.appendChild(back); topbar.appendChild(w2);
      }
    }

    function renderLauncher() {
      view = 'launcher'; currentSlug = null;
      removeIframe();
      renderTopbar();
      bodyEl.innerHTML = '';
      var launcher = el('div', 'nc-launcher');

      CATEGORIES.forEach(function (cat) {
        var items = CALCULATORS.filter(function (c) { return c.category === cat.key; });
        if (!items.length) return;
        var sec = el('div', 'nc-section');
        var h = el('div', 'nc-cat'); h.appendChild(el('span', 'nc-cat-en', cat.title));
        h.appendChild(el('span', 'nc-cat-ru', cat.titleRu));
        sec.appendChild(h);
        var grid = el('div', 'nc-grid');
        items.forEach(function (c) {
          var card = el('button', 'nc-card'); card.type = 'button';
          if (c.slug === lastOpened) card.classList.add('recent');
          card.appendChild(el('div', 'nc-card-title', c.titleRu));
          card.appendChild(el('div', 'nc-card-en', c.title));
          if (c.descRu) card.appendChild(el('div', 'nc-card-desc', c.descRu));
          on(card, 'click', function () { openCalc(c.slug); });
          grid.appendChild(card);
        });
        sec.appendChild(grid);
        launcher.appendChild(sec);
      });

      var safety = el('div', 'nc-safety');
      var se = el('span'); se.appendChild(el('strong', null, 'Safety — ')); se.appendChild(document.createTextNode(SAFETY_EN));
      safety.appendChild(se);
      safety.appendChild(el('span', 'ru', SAFETY_RU));
      launcher.appendChild(safety);

      bodyEl.appendChild(launcher);
    }

    function removeIframe() {
      if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
      iframe = null;
    }

    function openCalc(slug) {
      var c = calcBySlug(slug);
      if (!c) return;
      view = 'calc'; currentSlug = slug;
      lastOpened = slug; store.set('lastOpened', slug);
      if (hostApi && hostApi.navigation && hostApi.navigation.setTitle) {
        try { hostApi.navigation.setTitle(c.title); } catch (e) {}
      }
      renderTopbar();
      bodyEl.innerHTML = '';
      var viewer = el('div', 'nc-viewer');
      iframe = document.createElement('iframe');
      iframe.className = 'nc-frame';
      iframe.setAttribute('sandbox', SANDBOX);
      iframe.setAttribute('title', c.title);
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.srcdoc = buildSrcdoc(c, theme);
      viewer.appendChild(iframe);
      bodyEl.appendChild(viewer);
    }

    function closeCalc() {
      if (hostApi && hostApi.navigation && hostApi.navigation.setTitle) {
        try { hostApi.navigation.setTitle('Navigation Calculators'); } catch (e) {}
      }
      renderLauncher();
    }

    function applyTheme(next) {
      if (!next || next === theme || !root) { theme = next || theme; return; }
      theme = next;
      root.classList.toggle('theme-light', theme === 'light');
      root.classList.toggle('theme-dark', theme === 'dark');
      if (view === 'calc' && iframe && currentSlug) {
        iframe.srcdoc = buildSrcdoc(calcBySlug(currentSlug), theme); // re-skin open calc
      }
    }

    function start() {
      build();
      renderLauncher();
      if (hostApi && hostApi.navigation && hostApi.navigation.setTitle) {
        try { hostApi.navigation.setTitle('Navigation Calculators'); } catch (e) {}
      }
      if (hostApi && hostApi.theme && typeof hostApi.theme.subscribe === 'function') {
        try {
          var unsub = hostApi.theme.subscribe(function (t) { if (!destroyed) applyTheme(normalizeTheme(t) || readHostTheme(hostApi)); });
          if (typeof unsub === 'function') themeUnsub = unsub;
        } catch (e) {}
      }
    }

    function destroy() {
      destroyed = true;
      removeIframe();
      listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2]); } catch (e) {} });
      listeners = [];
      if (themeUnsub) { try { themeUnsub(); } catch (e) {} themeUnsub = null; }
      if (root && root.parentNode) { try { root.parentNode.removeChild(root); } catch (e) {} }
      try { container.innerHTML = ''; } catch (e) {}
      root = null;
    }

    var testApi = {
      snapshot: function () {
        return {
          view: view, currentSlug: currentSlug, theme: theme,
          cardCount: root ? root.querySelectorAll('.nc-card').length : 0,
          sectionCount: root ? root.querySelectorAll('.nc-section').length : 0,
          hasIframe: !!iframe,
          sandbox: iframe ? iframe.getAttribute('sandbox') : null,
          themeLight: !!(root && root.classList.contains('theme-light'))
        };
      },
      slugs: function () { return CALCULATORS.map(function (c) { return c.slug; }); },
      open: openCalc,
      close: closeCalc,
      currentSrcdoc: function () { return iframe ? iframe.getAttribute('srcdoc') : null; }
    };

    return { start: start, destroy: destroy, testApi: testApi };
  }

  function mount(container, hostApi) {
    if (!container) throw new Error('[navigation-calculators] mount requires a container');
    if (current) { try { unmount(); } catch (e) {} }
    var inst = createInstance(container, hostApi || {});
    current = inst;
    inst.start();
    if (typeof window !== 'undefined' && window.__SKIPI_PLUGIN_TEST__) {
      window.SkipiPlugins[KEY].__test = inst.testApi;
    }
  }

  function unmount() {
    if (!current) return;
    try { current.destroy(); } catch (e) {}
    current = null;
    if (window.SkipiPlugins && window.SkipiPlugins[KEY]) { try { delete window.SkipiPlugins[KEY].__test; } catch (e) {} }
  }

  window.SkipiPlugins = window.SkipiPlugins || {};
  window.SkipiPlugins[KEY] = { manifest: manifest, mount: mount, unmount: unmount };
})();
