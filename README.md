# ShRec3D

Implementation of the algorithm described in [3D genome reconstruction from chromosomal contacts](http://www.nature.com/nmeth/journal/v11/n11/full/nmeth.3104.html).

# Usage
## Requirements
1. python3
2. python package in `requirements.txt`
3. ffmpeg (Optional)

## Coordinates_Calculation
Used to Generate `Coordinates Matrix`.

```shell
usage: Coordinates_Calculation [-h] -f F -o O
ExamPle: 

optional arguments:
  -h, --help  show this help message and exit
  -f F        Path to Balenced Full Matrix(CSV).
  -o O        Path to Output(CSV).
```

ExamPle: 
```shell
python3 -u src/Coordinates_Calculation.py -f data/mat.csv -o out/Coord.csv
```

## Visualizer
Used to Visualize `chromosomal Structure`.

```shell
usage: Visualizer [-h] -f F -o O -t T [-s S]

optional arguments:
  -h, --help  show this help message and exit
  -f F        Path to coordinates File(csv).
  -o O        Path to Output(SVG).
  -t T        Title of Image.
  -s S        Smooth Factor. May be 0.1, 1.0, 2.0,
```

ExamPle: 
```shell
python3 -u src/Visualizer.py -f out/Coord.csv -o out/out.svg -t chromosomal_No_1
```