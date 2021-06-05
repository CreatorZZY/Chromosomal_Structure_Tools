'''
Author: George Zhao
Date: 2021-06-05 12:07:05
LastEditors: George Zhao
LastEditTime: 2021-06-05 12:18:23
Description: 
Email: 2018221138@email.szu.edu.cn
Company: SZU
Version: 1.0
'''
import pandas as pd
import numpy as np


def get_matrix(Path_to_file: str, path_to_save: str):
    rdata = pd.read_csv(Path_to_file, delimiter='\t', header=None)
    rdata.rename(columns={0: 'x', 1: 'y', 2: 'z'}, inplace=True)
    data = rdata.copy()
    data['z'] = data['z'].map(lambda x: np.log10(x + 1))
    data1 = data.copy()
    cols = list(data1)
    cols.insert(0, cols.pop(cols.index('y')))
    data1 = data1.loc[:, cols]
    data1.rename(columns={'y': 'x', 'x': 'y', 'z': 'z'}, inplace=True)
    result = data.append(data1, ignore_index=True)
    result.reset_index(drop=True)
    re = result.pivot_table(index='x', columns='y', values='z')
    re.fillna(0, inplace=True)
    np.savetxt(path_to_save, re.values, delimiter=",")


if __name__ == '__main__':

    import argparse
    parser = argparse.ArgumentParser(prog='FullSizeMatrix_Generator')
    parser.add_argument('-f', type=str, required=True,
                        help='Path to Original Hi-C balanced Sparse Matrix File.')
    parser.add_argument('-o', type=str, required=True,
                        help='Path to Output of Full Size Matrix(CSV).')
    args = parser.parse_args()

    get_matrix(args.f, args.o)
