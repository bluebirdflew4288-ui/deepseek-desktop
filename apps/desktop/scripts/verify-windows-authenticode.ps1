param(
  [Parameter(Mandatory = $true)]
  [string[]] $Path,
  [Parameter(Mandatory = $true)]
  [string] $ZipPath,
  [Parameter(Mandatory = $true)]
  [string] $ZipExecutableName,
  [ValidateSet('Valid', 'NotSigned')]
  [string] $ExpectedStatus = 'Valid'
)

$ErrorActionPreference = 'Stop'
if ($ExpectedStatus -eq 'Valid') {
  $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
  $signtoolPath = if ($null -ne $signtool) { $signtool.Source } else { $null }
  if ([string]::IsNullOrWhiteSpace($signtoolPath)) {
    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    if (Test-Path -LiteralPath $kitsRoot) {
      $signtoolPath = Get-ChildItem -LiteralPath $kitsRoot -Directory |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    }
  }
  if ([string]::IsNullOrWhiteSpace([string]$signtoolPath)) {
    throw 'Windows SDK signtool.exe is required to verify the full signature chain.'
  }
}
$results = @()
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('desktop-release-zip-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
  if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
    throw 'Windows release ZIP is missing.'
  }
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $tempRoot -ErrorAction Stop
  $zipExecutable = Join-Path $tempRoot $ZipExecutableName
  if (-not (Test-Path -LiteralPath $zipExecutable -PathType Leaf)) {
    throw 'Application executable is missing from the release ZIP.'
  }
  $looseHash = (Get-FileHash -LiteralPath $Path[-1] -Algorithm SHA256).Hash
  $zipHash = (Get-FileHash -LiteralPath $zipExecutable -Algorithm SHA256).Hash
  if ($looseHash -cne $zipHash) {
    throw 'Application executable hash in the release ZIP does not match the loose executable.'
  }
  $Path += $zipExecutable

  foreach ($file in $Path) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw "Windows release executable is missing: $(Split-Path -Leaf $file)"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status.ToString() -cne $ExpectedStatus) {
      throw "Expected Authenticode status $ExpectedStatus for $(Split-Path -Leaf $file), got $($signature.Status.ToString())."
    }
    $timestampCertificate = $signature.TimeStamperCertificate
    $timestampEkus = @()
    if ($null -ne $timestampCertificate) {
      $timestampEkus = @(
        $timestampCertificate.Extensions |
          Where-Object { $_.Oid.Value -eq '2.5.29.37' } |
          ForEach-Object { $_.EnhancedKeyUsages } |
          ForEach-Object { $_.Value }
      )
    }
    $signtoolSucceeded = $false
    if ($ExpectedStatus -eq 'Valid') {
      $verification = & $signtoolPath verify /pa /all /v $file 2>&1
      $signtoolSucceeded = $LASTEXITCODE -eq 0 -and (($verification | Out-String) -match '(?i)Successfully verified')
    }
    $results += [ordered]@{
      status = $signature.Status.ToString()
      signerSubject = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Subject }
      timestampSubject = if ($null -eq $timestampCertificate) { $null } else { $timestampCertificate.Subject }
      timestampEkus = @($timestampEkus)
      trustedChain = ($ExpectedStatus -eq 'Valid' -and $signature.Status.ToString() -ceq 'Valid' -and $signtoolSucceeded)
      signtoolSucceeded = $signtoolSucceeded
    }
  }

  ConvertTo-Json -InputObject @($results) -Compress -Depth 5
}
finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
