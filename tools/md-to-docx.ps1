<#
    md-to-docx.ps1

    Renders a markdown document into a .docx that matches the Seamless FM
    documentation system used by "Documentation Templates/*.docx" — Calibri,
    navy section rules, navy/zebra tables, accent callouts, running head and
    "Page X of Y" footer.

    Example:
      .\tools\md-to-docx.ps1 `
        -InputFile  "PRD-WRK-001-work-order-platform.md" `
        -OutputFile "The One - PRD - Work Order Platform.docx" `
        -Eyebrow    "PRODUCT REQUIREMENTS DOCUMENT" `
        -Title      "The One - Work Order Platform" `
        -Subtitle   "PRD-WRK-001 - v1 - Intake to collection" `
        -RunningHead "PRD-WRK-001  Work Order Platform (v1)"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InputFile,
    [Parameter(Mandatory = $true)][string]$OutputFile,
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Eyebrow = '',
    [string]$Subtitle = '',
    [string]$RunningHead = '',
    [string]$Creator = 'Seamless Facility Management'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ---------------------------------------------------------------- palette ---
$NAVY   = '0A1628'   # titles, table header fill
$ACCENT = '1A9FD4'   # rules, eyebrow, H3, callout edge
$INK   = '14201B'   # body text
$MUTED  = '6E7D76'   # running head / footer / subtitle
$HAIRLINE   = 'D5DDE2'   # table + header/footer hairlines
$TINT   = 'F2F8FC'   # zebra rows, callout fill

$CONTENT_W = 9020    # printable width in twips (A4, 1" margins)

# ------------------------------------------------------------------ utils ---
function ConvertTo-XmlText([string]$s) {
    if ([string]::IsNullOrEmpty($s)) { return '' }
    $s = $s -replace '&', '&amp;'
    $s = $s -replace '<', '&lt;'
    $s = $s -replace '>', '&gt;'
    # strip control characters XML will not accept
    return ($s -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', '')
}

function New-Run {
    param(
        [string]$Text,
        [int]$Size = 20,
        [string]$Color = $INK,
        [bool]$Bold = $false,
        [bool]$Italic = $false,
        [bool]$Mono = $false,
        [bool]$ExplicitFlags = $false,
        [int]$Spacing = 0
    )
    $font = if ($Mono) { 'Consolas' } else { 'Calibri' }
    $rpr = "<w:rFonts w:ascii=`"$font`" w:cs=`"$font`" w:eastAsia=`"$font`" w:hAnsi=`"$font`"/>"
    if ($Bold) { $rpr += '<w:b/><w:bCs/>' } elseif ($ExplicitFlags) { $rpr += '<w:b w:val="false"/><w:bCs w:val="false"/>' }
    if ($Italic) { $rpr += '<w:i/><w:iCs/>' } elseif ($ExplicitFlags) { $rpr += '<w:i w:val="false"/><w:iCs w:val="false"/>' }
    $rpr += "<w:color w:val=`"$Color`"/>"
    if ($Spacing -ne 0) { $rpr += "<w:spacing w:val=`"$Spacing`"/>" }
    $rpr += "<w:sz w:val=`"$Size`"/><w:szCs w:val=`"$Size`"/>"
    return "<w:r><w:rPr>$rpr</w:rPr><w:t xml:space=`"preserve`">$(ConvertTo-XmlText $Text)</w:t></w:r>"
}

# Turns inline markdown (**bold**, *italic*, `code`, [text](url)) into runs.
function ConvertTo-Runs {
    param(
        [string]$Md,
        [int]$Size = 20,
        [string]$Color = $INK,
        [bool]$Bold = $false,
        [bool]$Italic = $false,
        [bool]$ExplicitFlags = $false
    )
    if ($null -eq $Md) { $Md = '' }

    # links -> their text; images dropped
    $Md = [regex]::Replace($Md, '!\[[^\]]*\]\([^)]*\)', '')
    $Md = [regex]::Replace($Md, '\[([^\]]*)\]\([^)]*\)', '$1')
    $Md = $Md -replace '\\\|', '|'

    $out = New-Object System.Text.StringBuilder
    $plain = New-Object System.Text.StringBuilder
    $i = 0

    while ($i -lt $Md.Length) {
        $rest = $Md.Substring($i)

        # `code`
        if ($rest[0] -eq '`') {
            $end = $rest.IndexOf('`', 1)
            if ($end -gt 0) {
                if ($plain.Length -gt 0) {
                    [void]$out.Append((New-Run -Text $plain.ToString() -Size $Size -Color $Color -Bold $Bold -Italic $Italic -ExplicitFlags $ExplicitFlags))
                    [void]$plain.Clear()
                }
                [void]$out.Append((New-Run -Text $rest.Substring(1, $end - 1) -Size $Size -Color $NAVY -Bold $Bold -Italic $Italic -Mono $true -ExplicitFlags $ExplicitFlags))
                $i += $end + 1
                continue
            }
        }

        # ***bold italic*** / **bold** / *italic* / _italic_
        $marker = $null; $inner = $null; $consumed = 0
        foreach ($m in @('***', '**', '*')) {
            if ($rest.StartsWith($m)) {
                $end = $rest.IndexOf($m, $m.Length)
                if ($end -gt 0) { $marker = $m; $inner = $rest.Substring($m.Length, $end - $m.Length); $consumed = $end + $m.Length }
                break
            }
        }
        if ($marker -and -not [string]::IsNullOrWhiteSpace($inner)) {
            if ($plain.Length -gt 0) {
                [void]$out.Append((New-Run -Text $plain.ToString() -Size $Size -Color $Color -Bold $Bold -Italic $Italic -ExplicitFlags $ExplicitFlags))
                [void]$plain.Clear()
            }
            $nb = $Bold -or ($marker -eq '**') -or ($marker -eq '***')
            $ni = $Italic -or ($marker -eq '*') -or ($marker -eq '***')
            [void]$out.Append((ConvertTo-Runs -Md $inner -Size $Size -Color $Color -Bold $nb -Italic $ni -ExplicitFlags $ExplicitFlags))
            $i += $consumed
            continue
        }

        [void]$plain.Append($Md[$i])
        $i++
    }

    if ($plain.Length -gt 0) {
        [void]$out.Append((New-Run -Text $plain.ToString() -Size $Size -Color $Color -Bold $Bold -Italic $Italic -ExplicitFlags $ExplicitFlags))
    }
    if ($out.Length -eq 0) {
        [void]$out.Append((New-Run -Text '' -Size $Size -Color $Color -Bold $Bold -Italic $Italic -ExplicitFlags $ExplicitFlags))
    }
    return $out.ToString()
}

# Plain text of an inline string, used for column-width weighting.
function Get-PlainText([string]$Md) {
    if ($null -eq $Md) { return '' }
    $t = [regex]::Replace($Md, '\[([^\]]*)\]\([^)]*\)', '$1')
    return ($t -replace '[*`_\\]', '')
}

# ----------------------------------------------------------------- blocks ---
function New-CoverBlock {
    $xml = '<w:p><w:pPr><w:spacing w:after="700"/></w:pPr>' + (New-Run -Text '') + '</w:p>'
    if ($Eyebrow) {
        $xml += '<w:p><w:pPr><w:spacing w:after="160"/></w:pPr>' +
                (New-Run -Text $Eyebrow.ToUpper() -Size 18 -Color $ACCENT -Bold $true -Spacing 60) + '</w:p>'
    }
    $xml += '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>' +
            (New-Run -Text $Title -Size 56 -Color $NAVY -Bold $true) + '</w:p>'
    $xml += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:color="' + $ACCENT + '" w:sz="18" w:space="10"/></w:pBdr><w:spacing w:after="320"/></w:pPr>' +
            (New-Run -Text $Subtitle -Size 24 -Color $MUTED) + '</w:p>'
    return $xml
}

function New-Heading {
    param([int]$Level, [string]$Text)

    # "1. Summary" -> "1.  Summary"; leaves unnumbered headings alone
    $t = [regex]::Replace($Text, '^((?:\d+|[A-Z])(?:\.\d+)*\.?)\s+', '$1  ')

    switch ($Level) {
        1 {
            return '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:pBdr><w:bottom w:val="single" w:color="' + $ACCENT + '" w:sz="10" w:space="6"/></w:pBdr><w:spacing w:after="160" w:before="360"/></w:pPr>' +
                   (ConvertTo-Runs -Md $t.ToUpper() -Size 26 -Color $NAVY -Bold $true) + '</w:p>'
        }
        2 {
            return '<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:spacing w:after="120" w:before="260"/></w:pPr>' +
                   (ConvertTo-Runs -Md $t -Size 22 -Color $NAVY -Bold $true) + '</w:p>'
        }
        default {
            return '<w:p><w:pPr><w:pStyle w:val="Heading3"/><w:spacing w:after="100" w:before="200"/></w:pPr>' +
                   (ConvertTo-Runs -Md $t -Size 20 -Color $ACCENT -Bold $true) + '</w:p>'
        }
    }
}

function New-BodyParagraph([string]$Text) {
    return '<w:p><w:pPr><w:spacing w:after="120" w:before="0" w:line="276"/></w:pPr>' +
           (ConvertTo-Runs -Md $Text -Size 20 -Color $INK) + '</w:p>'
}

function New-BulletParagraph([string]$Text, [int]$NumId = 1, [int]$Level = 0) {
    return '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="' + $Level + '"/><w:numId w:val="' + $NumId + '"/></w:numPr><w:spacing w:after="80" w:line="276"/></w:pPr>' +
           (ConvertTo-Runs -Md $Text -Size 20 -Color $INK) + '</w:p>'
}

function New-CheckboxParagraph([string]$Text, [bool]$Checked) {
    $box = if ($Checked) { [char]0x2611 } else { [char]0x2610 }
    return '<w:p><w:pPr><w:spacing w:after="80" w:line="276"/><w:ind w:left="200"/></w:pPr>' +
           (New-Run -Text "$box   " -Size 22 -Color $ACCENT) +
           (ConvertTo-Runs -Md $Text -Size 20 -Color $INK) + '</w:p>'
}

function New-Callout([string[]]$Lines) {
    $xml = ''
    foreach ($line in $Lines) {
        $xml += '<w:p><w:pPr><w:pBdr><w:left w:val="single" w:color="' + $ACCENT + '" w:sz="18" w:space="8"/></w:pBdr><w:shd w:fill="' + $TINT + '" w:val="clear"/><w:spacing w:after="200" w:before="120" w:line="276"/><w:ind w:left="140" w:right="140"/></w:pPr>' +
                (ConvertTo-Runs -Md $line -Size 19 -Color $INK) + '</w:p>'
    }
    return $xml
}

function New-Table([string[]]$Lines) {
    # split rows, honouring escaped pipes
    $rows = @()
    foreach ($line in $Lines) {
        $t = $line.Trim()
        if ($t.StartsWith('|')) { $t = $t.Substring(1) }
        if ($t.EndsWith('|') -and -not $t.EndsWith('\|')) { $t = $t.Substring(0, $t.Length - 1) }
        $cells = [regex]::Split($t, '(?<!\\)\|') | ForEach-Object { $_.Trim() }
        $rows += , @($cells)
    }
    if ($rows.Count -lt 1) { return '' }

    # drop the --- separator row
    $isSep = { param($r) ($r.Count -gt 0) -and (($r | Where-Object { $_ -notmatch '^:?-{1,}:?$' }).Count -eq 0) }
    $header = $rows[0]
    $body = @()
    for ($r = 1; $r -lt $rows.Count; $r++) {
        if (& $isSep $rows[$r]) { continue }
        $body += , $rows[$r]
    }

    $cols = $header.Count
    foreach ($r in $body) { if ($r.Count -gt $cols) { $cols = $r.Count } }

    # Column widths: content-proportional (damped, so one long column cannot
    # swallow the table) but never narrower than the longest single body word,
    # which is what makes identifiers like "BR-WRK-004" wrap three ways.
    $all = @(, $header) + $body
    $weights = @()
    $floors = @()
    for ($c = 0; $c -lt $cols; $c++) {
        $maxLen = 6
        foreach ($r in $all) {
            if ($c -lt $r.Count) {
                $l = (Get-PlainText $r[$c]).Length
                if ($l -gt $maxLen) { $maxLen = $l }
            }
        }
        if ($maxLen -gt 90) { $maxLen = 90 }
        $weights += [Math]::Pow($maxLen, 0.7)

        $longestWord = 0
        foreach ($r in $body) {
            if ($c -lt $r.Count) {
                foreach ($tok in (Get-PlainText $r[$c]) -split '\s+') {
                    if ($tok.Length -gt $longestWord) { $longestWord = $tok.Length }
                }
            }
        }
        if ($longestWord -gt 12) { $longestWord = 12 }
        $f = ($longestWord * 100) + 220
        if ($f -lt 620) { $f = 620 }
        $floors += $f
    }

    $sum = ($weights | Measure-Object -Sum).Sum
    $widths = @()
    for ($c = 0; $c -lt $cols; $c++) {
        $w = [int][Math]::Round($CONTENT_W * $weights[$c] / $sum)
        if ($w -lt $floors[$c]) { $w = $floors[$c] }
        $widths += $w
    }

    # give back any overshoot, taken from the columns with slack above their floor
    $total = ($widths | Measure-Object -Sum).Sum
    if ($total -gt $CONTENT_W) {
        $slack = @(); for ($c = 0; $c -lt $cols; $c++) { $slack += ($widths[$c] - $floors[$c]) }
        $slackSum = ($slack | Measure-Object -Sum).Sum
        $excess = $total - $CONTENT_W
        if ($slackSum -gt 0) {
            for ($c = 0; $c -lt $cols; $c++) {
                $widths[$c] = $widths[$c] - [int][Math]::Floor($excess * $slack[$c] / $slackSum)
            }
        } else {
            for ($c = 0; $c -lt $cols; $c++) {
                $widths[$c] = [int][Math]::Floor($widths[$c] * $CONTENT_W / $total)
            }
        }
    }
    # settle the rounding on the widest column so the grid totals exactly
    $total = ($widths | Measure-Object -Sum).Sum
    if ($total -ne $CONTENT_W) {
        $widest = 0
        for ($c = 1; $c -lt $cols; $c++) { if ($widths[$c] -gt $widths[$widest]) { $widest = $c } }
        $widths[$widest] = $widths[$widest] + ($CONTENT_W - $total)
    }

    $borders = '<w:tblBorders>' +
               "<w:top w:val=`"single`" w:color=`"$HAIRLINE`" w:sz=`"4`"/>" +
               "<w:left w:val=`"single`" w:color=`"$HAIRLINE`" w:sz=`"4`"/>" +
               "<w:bottom w:val=`"single`" w:color=`"$HAIRLINE`" w:sz=`"4`"/>" +
               "<w:right w:val=`"single`" w:color=`"$HAIRLINE`" w:sz=`"4`"/>" +
               "<w:insideH w:val=`"single`" w:color=`"$HAIRLINE`" w:sz=`"4`"/>" +
               "<w:insideV w:val=`"single`" w:color=`"$HAIRLINE`" w:sz=`"4`"/>" +
               '</w:tblBorders>'

    $xml = "<w:tbl><w:tblPr><w:tblW w:type=`"dxa`" w:w=`"$CONTENT_W`"/>$borders</w:tblPr><w:tblGrid>"
    foreach ($w in $widths) { $xml += "<w:gridCol w:w=`"$w`"/>" }
    $xml += '</w:tblGrid>'

    $mar = '<w:tcMar><w:top w:type="dxa" w:w="60"/><w:left w:type="dxa" w:w="90"/><w:bottom w:type="dxa" w:w="60"/><w:right w:type="dxa" w:w="90"/></w:tcMar>'

    # header row
    $xml += '<w:tr><w:trPr><w:tblHeader/></w:trPr>'
    for ($c = 0; $c -lt $cols; $c++) {
        $text = if ($c -lt $header.Count) { $header[$c] } else { '' }
        $xml += "<w:tc><w:tcPr><w:tcW w:type=`"dxa`" w:w=`"$($widths[$c])`"/><w:shd w:fill=`"$NAVY`" w:val=`"clear`"/>$mar<w:vAlign w:val=`"top`"/></w:tcPr>" +
                '<w:p><w:pPr><w:spacing w:after="40" w:before="40" w:line="252"/></w:pPr>' +
                (ConvertTo-Runs -Md $text -Size 18 -Color 'FFFFFF' -Bold $true -ExplicitFlags $true) + '</w:p></w:tc>'
    }
    $xml += '</w:tr>'

    # body rows, zebra striped
    for ($r = 0; $r -lt $body.Count; $r++) {
        $fill = if ($r % 2 -eq 0) { 'FFFFFF' } else { $TINT }
        $xml += '<w:tr>'
        for ($c = 0; $c -lt $cols; $c++) {
            $text = if ($c -lt $body[$r].Count) { $body[$r][$c] } else { '' }
            $xml += "<w:tc><w:tcPr><w:tcW w:type=`"dxa`" w:w=`"$($widths[$c])`"/><w:shd w:fill=`"$fill`" w:val=`"clear`"/>$mar<w:vAlign w:val=`"top`"/></w:tcPr>" +
                    '<w:p><w:pPr><w:spacing w:after="40" w:before="40" w:line="252"/></w:pPr>' +
                    (ConvertTo-Runs -Md $text -Size 18 -Color $INK -ExplicitFlags $true) + '</w:p></w:tc>'
        }
        $xml += '</w:tr>'
    }

    $xml += '</w:tbl>'
    # Word needs a paragraph between/after tables
    $xml += '<w:p><w:pPr><w:spacing w:after="0" w:line="120"/></w:pPr>' + (New-Run -Text '' -Size 12) + '</w:p>'
    return $xml
}

# ------------------------------------------------------------------ parse ---
$srcPath = (Resolve-Path -LiteralPath $InputFile).Path
$lines = [System.IO.File]::ReadAllLines($srcPath)

$bodyXml = New-Object System.Text.StringBuilder
[void]$bodyXml.Append((New-CoverBlock))

$i = 0
$seenFirstHeading = $false
$paraBuf = New-Object System.Collections.ArrayList

function Flush-Paragraph {
    if ($script:paraBuf.Count -gt 0) {
        [void]$script:bodyXml.Append((New-BodyParagraph ($script:paraBuf -join ' ')))
        $script:paraBuf.Clear()
    }
}

while ($i -lt $lines.Count) {
    $line = $lines[$i]
    $trim = $line.Trim()

    # blank
    if ($trim -eq '') { Flush-Paragraph; $i++; continue }

    # horizontal rule — the system uses heading rules instead
    if ($trim -match '^(-{3,}|\*{3,}|_{3,})$') { Flush-Paragraph; $i++; continue }

    # heading
    if ($trim -match '^(#{1,6})\s+(.*)$') {
        Flush-Paragraph
        $hashes = $Matches[1].Length
        $text = $Matches[2].Trim()
        if (-not $seenFirstHeading -and $hashes -eq 1) {
            $seenFirstHeading = $true
            $i++
            continue   # the document title already lives on the cover
        }
        $seenFirstHeading = $true
        $level = [Math]::Max(1, $hashes - 1)
        if ($level -gt 3) { $level = 3 }
        [void]$bodyXml.Append((New-Heading -Level $level -Text $text))
        $i++
        continue
    }

    # table
    if ($trim.StartsWith('|')) {
        Flush-Paragraph
        $tbl = @()
        while ($i -lt $lines.Count -and $lines[$i].Trim().StartsWith('|')) {
            $tbl += $lines[$i]
            $i++
        }
        [void]$bodyXml.Append((New-Table $tbl))
        continue
    }

    # blockquote / callout
    if ($trim.StartsWith('>')) {
        Flush-Paragraph
        $quote = @()
        $cur = ''
        while ($i -lt $lines.Count -and $lines[$i].Trim().StartsWith('>')) {
            $q = $lines[$i].Trim()
            $q = $q.Substring(1).Trim()
            if ($q -eq '') {
                if ($cur) { $quote += $cur; $cur = '' }
            } else {
                $cur = if ($cur) { "$cur $q" } else { $q }
            }
            $i++
        }
        if ($cur) { $quote += $cur }
        [void]$bodyXml.Append((New-Callout $quote))
        continue
    }

    # checkbox item
    if ($trim -match '^[-*+]\s+\[([ xX])\]\s*(.*)$') {
        Flush-Paragraph
        [void]$bodyXml.Append((New-CheckboxParagraph -Text $Matches[2].Trim() -Checked ($Matches[1] -ne ' ')))
        $i++
        continue
    }

    # bullet
    if ($trim -match '^[-*+]\s+(.*)$') {
        Flush-Paragraph
        $indent = $line.Length - $line.TrimStart().Length
        $lvl = [Math]::Min(2, [int][Math]::Floor($indent / 2))
        [void]$bodyXml.Append((New-BulletParagraph -Text $Matches[1].Trim() -NumId 1 -Level $lvl))
        $i++
        continue
    }

    # ordered item
    if ($trim -match '^\d+[.)]\s+(.*)$') {
        Flush-Paragraph
        $indent = $line.Length - $line.TrimStart().Length
        $lvl = [Math]::Min(2, [int][Math]::Floor($indent / 2))
        [void]$bodyXml.Append((New-BulletParagraph -Text $Matches[1].Trim() -NumId 2 -Level $lvl))
        $i++
        continue
    }

    # ordinary prose — soft-wrapped lines join into one paragraph
    [void]$paraBuf.Add($trim)
    $i++
}
Flush-Paragraph

# ------------------------------------------------------------- assemble ---
$NS = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
      'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"'

$sectPr = '<w:sectPr><w:headerReference w:type="default" r:id="rId7"/><w:footerReference w:type="default" r:id="rId8"/>' +
          '<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/>' +
          '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>' +
          '<w:pgNumType/><w:docGrid w:linePitch="360"/></w:sectPr>'

$documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
               "<w:document mc:Ignorable=`"w14 w15`" $NS><w:body>" + $bodyXml.ToString() + $sectPr + '</w:body></w:document>'

if (-not $RunningHead) { $RunningHead = $Title }

$headerXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
             "<w:hdr mc:Ignorable=`"w14 w15`" $NS>" +
             '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:color="' + $HAIRLINE + '" w:sz="6" w:space="6"/></w:pBdr><w:spacing w:after="0"/></w:pPr>' +
             (New-Run -Text $RunningHead -Size 16 -Color $MUTED -Spacing 30) +
             '</w:p></w:hdr>'

$fldRpr = "<w:rPr><w:rFonts w:ascii=`"Calibri`" w:cs=`"Calibri`" w:eastAsia=`"Calibri`" w:hAnsi=`"Calibri`"/><w:color w:val=`"$MUTED`"/><w:sz w:val=`"16`"/><w:szCs w:val=`"16`"/></w:rPr>"
$footerXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
             "<w:ftr mc:Ignorable=`"w14 w15`" $NS>" +
             '<w:p><w:pPr><w:pBdr><w:top w:val="single" w:color="' + $HAIRLINE + '" w:sz="6" w:space="6"/></w:pBdr><w:jc w:val="right"/></w:pPr>' +
             (New-Run -Text "$Creator  $([char]0x00B7)  Page " -Size 16 -Color $MUTED) +
             "<w:r>$fldRpr<w:fldChar w:fldCharType=`"begin`"/></w:r>" +
             "<w:r>$fldRpr<w:instrText xml:space=`"preserve`"> PAGE </w:instrText></w:r>" +
             "<w:r>$fldRpr<w:fldChar w:fldCharType=`"separate`"/></w:r>" +
             "<w:r>$fldRpr<w:t>1</w:t></w:r>" +
             "<w:r>$fldRpr<w:fldChar w:fldCharType=`"end`"/></w:r>" +
             (New-Run -Text ' of ' -Size 16 -Color $MUTED) +
             "<w:r>$fldRpr<w:fldChar w:fldCharType=`"begin`"/></w:r>" +
             "<w:r>$fldRpr<w:instrText xml:space=`"preserve`"> NUMPAGES </w:instrText></w:r>" +
             "<w:r>$fldRpr<w:fldChar w:fldCharType=`"separate`"/></w:r>" +
             "<w:r>$fldRpr<w:t>1</w:t></w:r>" +
             "<w:r>$fldRpr<w:fldChar w:fldCharType=`"end`"/></w:r>" +
             '</w:p></w:ftr>'

$stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    "<w:styles mc:Ignorable=`"w14 w15`" $NS>" +
    "<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=`"Calibri`" w:cs=`"Calibri`" w:eastAsia=`"Calibri`" w:hAnsi=`"Calibri`"/><w:color w:val=`"$INK`"/><w:sz w:val=`"20`"/><w:szCs w:val=`"20`"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>" +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    "<w:style w:type=`"paragraph`" w:styleId=`"Title`"><w:name w:val=`"Title`"/><w:basedOn w:val=`"Normal`"/><w:next w:val=`"Normal`"/><w:qFormat/><w:rPr><w:b/><w:color w:val=`"$NAVY`"/><w:sz w:val=`"56`"/><w:szCs w:val=`"56`"/></w:rPr></w:style>" +
    "<w:style w:type=`"paragraph`" w:styleId=`"Heading1`"><w:name w:val=`"heading 1`"/><w:basedOn w:val=`"Normal`"/><w:next w:val=`"Normal`"/><w:qFormat/><w:pPr><w:outlineLvl w:val=`"0`"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val=`"$NAVY`"/><w:sz w:val=`"26`"/><w:szCs w:val=`"26`"/></w:rPr></w:style>" +
    "<w:style w:type=`"paragraph`" w:styleId=`"Heading2`"><w:name w:val=`"heading 2`"/><w:basedOn w:val=`"Normal`"/><w:next w:val=`"Normal`"/><w:qFormat/><w:pPr><w:outlineLvl w:val=`"1`"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val=`"$NAVY`"/><w:sz w:val=`"22`"/><w:szCs w:val=`"22`"/></w:rPr></w:style>" +
    "<w:style w:type=`"paragraph`" w:styleId=`"Heading3`"><w:name w:val=`"heading 3`"/><w:basedOn w:val=`"Normal`"/><w:next w:val=`"Normal`"/><w:qFormat/><w:pPr><w:outlineLvl w:val=`"2`"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val=`"$ACCENT`"/><w:sz w:val=`"20`"/><w:szCs w:val=`"20`"/></w:rPr></w:style>" +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>' +
    "<w:style w:type=`"character`" w:styleId=`"Hyperlink`"><w:name w:val=`"Hyperlink`"/><w:basedOn w:val=`"DefaultParagraphFont`"/><w:uiPriority w:val=`"99`"/><w:unhideWhenUsed/><w:rPr><w:color w:val=`"0563C1`"/><w:u w:val=`"single`"/></w:rPr></w:style>" +
    '</w:styles>'

function New-BulletLevels([string]$Glyph1, [string]$Glyph2, [string]$Glyph3) {
    $g = @($Glyph1, $Glyph2, $Glyph3)
    $x = ''
    for ($l = 0; $l -lt 3; $l++) {
        $ind = 360 + (360 * $l)
        $x += "<w:lvl w:ilvl=`"$l`"><w:start w:val=`"1`"/><w:numFmt w:val=`"bullet`"/><w:lvlText w:val=`"$($g[$l])`"/><w:lvlJc w:val=`"left`"/><w:pPr><w:ind w:left=`"$ind`" w:hanging=`"200`"/></w:pPr></w:lvl>"
    }
    return $x
}
$decLevels = ''
for ($l = 0; $l -lt 3; $l++) {
    $ind = 400 + (360 * $l)
    $fmt = @('decimal', 'lowerLetter', 'lowerRoman')[$l]
    $decLevels += "<w:lvl w:ilvl=`"$l`"><w:start w:val=`"1`"/><w:numFmt w:val=`"$fmt`"/><w:lvlText w:val=`"%$($l + 1).`"/><w:lvlJc w:val=`"left`"/><w:pPr><w:ind w:left=`"$ind`" w:hanging=`"280`"/></w:pPr></w:lvl>"
}

$numberingXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    "<w:numbering mc:Ignorable=`"w14 w15`" $NS>" +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    (New-BulletLevels ([char]0x2022) ([char]0x25E6) ([char]0x25AA)) + '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>' + $decLevels + '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>' +
    '</w:numbering>'

$settingsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    "<w:settings mc:Ignorable=`"w14 w15`" $NS><w:evenAndOddHeaders w:val=`"false`"/>" +
    '<w:updateFields w:val="true"/>' +
    '<w:compat><w:compatSetting w:val="15" w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word"/></w:compat></w:settings>'

$fontTableXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    "<w:fonts mc:Ignorable=`"w14 w15`" $NS>" +
    '<w:font w:name="Calibri"><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>' +
    '<w:font w:name="Consolas"><w:charset w:val="00"/><w:family w:val="modern"/><w:pitch w:val="fixed"/></w:font>' +
    '</w:fonts>'

$footnotesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    "<w:footnotes mc:Ignorable=`"w14 w15`" $NS>" +
    '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
    '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
    '</w:footnotes>'

$endnotesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    "<w:endnotes mc:Ignorable=`"w14 w15`" $NS>" +
    '<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>' +
    '<w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>' +
    '</w:endnotes>'

$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$corePropsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>$(ConvertTo-XmlText $Title)</dc:title>" +
    "<dc:subject>$(ConvertTo-XmlText $Subtitle)</dc:subject>" +
    "<dc:creator>$(ConvertTo-XmlText $Creator)</dc:creator>" +
    "<cp:lastModifiedBy>$(ConvertTo-XmlText $Creator)</cp:lastModifiedBy><cp:revision>1</cp:revision>" +
    "<dcterms:created xsi:type=`"dcterms:W3CDTF`">$now</dcterms:created>" +
    "<dcterms:modified xsi:type=`"dcterms:W3CDTF`">$now</dcterms:modified></cp:coreProperties>"

$appPropsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    "<Company>$(ConvertTo-XmlText $Creator)</Company><Application>md-to-docx.ps1</Application></Properties>"

$contentTypesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default ContentType="application/vnd.openxmlformats-package.relationships+xml" Extension="rels"/>' +
    '<Default ContentType="application/xml" Extension="xml"/>' +
    '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" PartName="/word/document.xml"/>' +
    '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml" PartName="/word/styles.xml"/>' +
    '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml" PartName="/word/numbering.xml"/>' +
    '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml" PartName="/word/settings.xml"/>' +
    '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml" PartName="/word/fontTable.xml"/>' +
    '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml" PartName="/word/footnotes.xml"/>' +
    '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml" PartName="/word/endnotes.xml"/>' +
    '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml" PartName="/word/header1.xml"/>' +
    '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml" PartName="/word/footer1.xml"/>' +
    '<Override ContentType="application/vnd.openxmlformats-package.core-properties+xml" PartName="/docProps/core.xml"/>' +
    '<Override ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml" PartName="/docProps/app.xml"/>' +
    '</Types>'

$rootRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>'

$docRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>' +
    '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>' +
    '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
    '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
    '</Relationships>'

# --------------------------------------------------------------- package ---
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("docx-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage '_rels') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'word') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'word\_rels') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'docProps') -Force | Out-Null

$utf8 = New-Object System.Text.UTF8Encoding($false)
$parts = @{
    '[Content_Types].xml'        = $contentTypesXml
    '_rels\.rels'                = $rootRelsXml
    'word\document.xml'          = $documentXml
    'word\_rels\document.xml.rels' = $docRelsXml
    'word\styles.xml'            = $stylesXml
    'word\numbering.xml'         = $numberingXml
    'word\settings.xml'          = $settingsXml
    'word\fontTable.xml'         = $fontTableXml
    'word\footnotes.xml'         = $footnotesXml
    'word\endnotes.xml'          = $endnotesXml
    'word\header1.xml'           = $headerXml
    'word\footer1.xml'           = $footerXml
    'docProps\core.xml'          = $corePropsXml
    'docProps\app.xml'           = $appPropsXml
}
foreach ($k in $parts.Keys) {
    [System.IO.File]::WriteAllText((Join-Path $stage $k), $parts[$k], $utf8)
}

$outPath = $OutputFile
if (-not [System.IO.Path]::IsPathRooted($outPath)) { $outPath = Join-Path (Get-Location).Path $outPath }
if (Test-Path -LiteralPath $outPath) { Remove-Item -LiteralPath $outPath -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $outPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item -LiteralPath $stage -Recurse -Force

$size = (Get-Item -LiteralPath $outPath).Length
Write-Output "OK  $([System.IO.Path]::GetFileName($outPath))  ($size bytes)"
