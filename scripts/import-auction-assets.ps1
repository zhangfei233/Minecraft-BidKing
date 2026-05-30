$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$resourceDir = Join-Path $root "resource\auction"
$itemsPath = Join-Path $root "items.csv"

Add-Type -AssemblyName System.Drawing

function CsvEscape($value) {
  $text = [string]$value
  if ($text -match '[,"\r\n]') {
    return '"' + $text.Replace('"', '""') + '"'
  }
  return $text
}

function Get-ImageSize($path) {
  $image = [System.Drawing.Image]::FromFile($path)
  try {
    return @{ Width = $image.Width; Height = $image.Height }
  }
  finally {
    $image.Dispose()
  }
}

function Get-ItemType($name) {
  if ($name -match 'Ore|Copper|Gold|Quartz|Amethyst|Obsidian') { return "ore" }
  if ($name -match 'Observer|Light Block|Material Reducer|MinecraftEdu|Lightning Rod|Lever|Pressure Plate|Button|TNT') { return "tech" }
  if ($name -match 'Sculk|Monster Spawner|Nether Reactor|Mysterious') { return "magic" }
  if ($name -match 'Head|Skull') { return "mob" }
  if ($name -match 'Melon') { return "food" }
  if ($name -match 'Log|Leaves|Sapling|Propagule|Roots|Stem|Mycelium|Moss|Mud|Netherrack|Nether Wart|Sprouts|Seagrass|Lily|Lilac|Mushroom|Sponge|Sea Pickle|Slime') { return "natural" }
  if ($name -match 'Chest|Shulker') { return "loot" }
  return "decoration"
}

function Get-Rarity($name, $type) {
  if ($name -match 'Mysterious|Nether Reactor') { return "red" }
  if ($name -match 'Monster Spawner|Sculk|Soul Campfire|Sea Lantern|Lodestone|Obsidian|TNT') { return "gold" }
  if ($name -match 'Shulker|Amethyst|Wither|Froglight|Lightning Rod|Material Reducer') { return "purple" }
  if ($name -match 'Nether|Magma|Locked chest|Player Head|Zombie Head|Skeleton Skull|Light Block') { return "blue" }
  if ($type -eq "ore") { return "green" }
  if ($name -match 'Door|Bed|Banner|Glazed|Loom|Lectern|Note Block|Observer') { return "green" }
  return "gray"
}

function Get-Size($name, $pixelWidth, $pixelHeight) {
  if ($name -match 'Bed') { return @{ Width = 3; Height = 2 } }
  if ($name -match 'Door|Banner') { return @{ Width = 2; Height = 4 } }
  if ($name -match 'Fence|Wall|Pane|Lightning Rod') { return @{ Width = 1; Height = 2 } }
  if ($name -match 'Button|Lever|Candle|Sea Pickle|Sapling|Flower|Lilac|Lily|Sprouts|Stem|Head|Skull') { return @{ Width = 1; Height = 1 } }

  $ratio = $pixelWidth / [Math]::Max(1, $pixelHeight)
  if ($ratio -ge 1.35) { return @{ Width = 3; Height = 2 } }
  if ($ratio -le 0.74) { return @{ Width = 2; Height = 3 } }
  return @{ Width = 2; Height = 2 }
}

function Get-Price($name, $type, $rarity, $width, $height) {
  $baseByRarity = @{
    gray = 800
    green = 3600
    blue = 12000
    purple = 36000
    gold = 90000
    red = 180000
  }
  $typeMultiplier = @{
    decoration = 1.0
    ore = 1.6
    tool = 1.2
    equipment = 1.4
    natural = 0.8
    food = 0.7
    tech = 1.5
    magic = 2.0
    mob = 1.3
    book = 1.1
    multiblock = 1.4
    loot = 1.7
  }
  $hash = 0
  foreach ($char in $name.ToCharArray()) { $hash += [int][char]$char }
  $variation = 0.75 + (($hash % 51) / 100.0)
  $area = $width * $height
  return [int][Math]::Round($baseByRarity[$rarity] * $typeMultiplier[$type] * $variation * [Math]::Sqrt($area / 4.0))
}

$rows = Get-Content -Path $itemsPath -Encoding UTF8
$ids = @()
foreach ($line in $rows | Select-Object -Skip 1) {
  if ($line.Trim().Length -eq 0) { continue }
  $ids += [int]($line.Split(",")[0].Trim())
}
$nextId = (($ids | Measure-Object -Maximum).Maximum) + 1

$newFiles = Get-ChildItem -Path $resourceDir -File |
  Where-Object { $_.BaseName -notmatch '^\d+$' -and $_.Extension.ToLowerInvariant() -in @(".png", ".gif") } |
  Sort-Object Name

$newRows = @()
foreach ($file in $newFiles) {
  $name = $file.BaseName
  $size = Get-ImageSize $file.FullName
  $type = Get-ItemType $name
  $rarity = Get-Rarity $name $type
  $gridSize = Get-Size $name $size.Width $size.Height
  $price = Get-Price $name $type $rarity $gridSize.Width $gridSize.Height
  $id = $nextId
  $nextId += 1

  $targetPath = Join-Path $resourceDir "$id.png"
  if ($file.Extension.ToLowerInvariant() -eq ".gif") {
    $image = [System.Drawing.Image]::FromFile($file.FullName)
    try {
      $image.Save($targetPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
      $image.Dispose()
    }
    Remove-Item -LiteralPath $file.FullName
  }
  else {
    Move-Item -LiteralPath $file.FullName -Destination $targetPath
  }

  $newRows += (@(
    $id,
    (CsvEscape $name),
    $type,
    "",
    $rarity,
    $gridSize.Height,
    $gridSize.Width,
    $price
  ) -join ",")
}

if ($newRows.Count -gt 0) {
  Add-Content -Path $itemsPath -Value $newRows -Encoding UTF8
}

Write-Output "Imported $($newRows.Count) auction assets."
