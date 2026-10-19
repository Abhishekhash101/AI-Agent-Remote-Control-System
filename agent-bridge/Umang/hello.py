"""A simple two-player tic-tac-toe game for the terminal."""


WINNING_LINES = (
    (0, 1, 2), (3, 4, 5), (6, 7, 8),
    (0, 3, 6), (1, 4, 7), (2, 5, 8),
    (0, 4, 8), (2, 4, 6),
)


def show_board(board):
    cells = [value if value != " " else str(i + 1) for i, value in enumerate(board)]
    print(f"\n {cells[0]} | {cells[1]} | {cells[2]}")
    print("---+---+---")
    print(f" {cells[3]} | {cells[4]} | {cells[5]}")
    print("---+---+---")
    print(f" {cells[6]} | {cells[7]} | {cells[8]}\n")


def has_won(board, player):
    return any(all(board[i] == player for i in line) for line in WINNING_LINES)


def main():
    board = [" "] * 9
    player = "X"
    print("Tic-Tac-Toe! Choose a square from 1 to 9. Type q to quit.")

    while True:
        show_board(board)
        choice = input(f"Player {player}, choose a square: ").strip().lower()
        if choice == "q":
            print("Game ended.")
            return
        if choice not in {str(i) for i in range(1, 10)}:
            print("Please enter a number from 1 to 9, or q to quit.")
            continue

        index = int(choice) - 1
        if board[index] != " ":
            print("That square is already taken. Try another.")
            continue

        board[index] = player
        if has_won(board, player):
            show_board(board)
            print(f"Player {player} wins!")
            return
        if " " not in board:
            show_board(board)
            print("It's a draw!")
            return
        player = "O" if player == "X" else "X"


if __name__ == "__main__":
    main()
