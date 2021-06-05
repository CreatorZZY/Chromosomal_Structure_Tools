'''
Author: George Zhao
Date: 2021-06-04 12:42:40
LastEditors: George Zhao
LastEditTime: 2021-06-05 13:08:43
Description: 
Email: 2018221138@email.szu.edu.cn
Company: SZU
Version: 1.0
'''
"""
Visualizer for 3D point clouds
"""


import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D
from scipy.ndimage.filters import gaussian_filter1d
from matplotlib import animation


def visualize(coords, path_to_save: str, title: str, smooth_Factor: float, border: bool, marker: str):
    """ Plot 3D coordinates
    """
    fig = plt.figure()
    ax = fig.gca(projection='3d')

    x, y, z = tuple((*zip(*coords),))

    y = gaussian_filter1d(y, sigma=smooth_Factor)
    x = gaussian_filter1d(x, sigma=smooth_Factor)
    z = gaussian_filter1d(z, sigma=smooth_Factor)

    N = len(z)
    if border == True:
        for i in range(N - 1):
            color = plt.cm.jet.reversed()(float(i) / float(N))
            a_1 = ax.plot(x[i:i + 2], y[i:i + 2], z[i:i + 2],
                          c=(0, 0, 0, 1.0), linewidth=6, markersize=7, solid_capstyle='round', marker=marker)
    for i in range(N - 1):
        color = plt.cm.jet.reversed()(float(i) / float(N))
        a_2 = ax.plot(x[i:i + 2], y[i:i + 2], z[i:i + 2],
                      c=color, linewidth=5, solid_capstyle='round', marker=marker)

    ax.text(x[0], y[0], z[0], '5\'')
    ax.text(x[N - 1], y[N - 1], z[N - 1], '3\'')
    ax.grid(False)
    # ax.axis(False)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_zticks([])

    ax.set_xlim(np.min(x), np.max(x))
    ax.set_ylim(np.min(y), np.max(y))
    ax.set_zlim(np.min(z), np.max(z))
    plt.title(title)
    plt.tight_layout()
    plt.savefig(f'{path_to_save}', format='svg', bbox_inches='tight')

    def init():
        return fig,

    def animate(i):
        ax.view_init(30, 10 * i)
        return fig,
    # plt.show()
    # ! animation
    # anim = animation.FuncAnimation(fig, animate, init_func=init,
    #                                frames=36, interval=1, blit=True)
    # anim.save(f'{title}_animation.mp4', fps=1,
    #           extra_args=['-vcodec', 'libx264'])


if __name__ == '__main__':

    import argparse
    parser = argparse.ArgumentParser(prog='Visualizer')
    parser.add_argument('-f', type=str, required=True,
                        help='Path to coordinates File(csv).')
    parser.add_argument('-o', type=str, required=True,
                        help='Path to Output(SVG).')
    parser.add_argument('-t', type=str, required=True,
                        help='Title of Image.')
    parser.add_argument('-s', type=float, default=1.0,
                        help='Smooth Factor. May be 0.1, 1.0, 2.0,')
    parser.add_argument('-b', action='store_true', default=False,
                        help='Line With Black Border.')
    parser.add_argument('-m', action='store_true', default=False,
                        help='Line End With Marker.')
    args = parser.parse_args()

    Path_to_file = args.f

    coords = np.loadtxt(Path_to_file, delimiter=',')
    visualize(coords, args.o, args.t, args.s,
              args.b, 'o'if args.m == True else None)
