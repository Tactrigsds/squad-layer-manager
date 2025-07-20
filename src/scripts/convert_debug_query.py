import re

import json
from typing import List, Union, Any

class SQLQueryFormatter:
    def __init__(self):
        self.indent_level = 0
        self.indent_size = 4

    def parse_debug_query(self, debug_text: str) -> tuple[str, List[Any]]:
        """
        Parse debug SQL query text to extract the query and parameters.

        Args:
            debug_text: The debug log text containing SQL query and params

        Returns:
            Tuple of (query_string, parameters_list)
        """
        lines = debug_text.strip().split('\n')

        # Find the query line (should contain SELECT, INSERT, UPDATE, DELETE)
        query_line = None
        params_line = None

        for i, line in enumerate(lines):
            line = line.strip()
            if any(keyword in line.upper() for keyword in ['SELECT', 'INSERT', 'UPDATE', 'DELETE']):
                # Extract everything after the timestamp and DEBUG tag
                if '] LDB:' in line:
                    query_line = line.split('] LDB:', 1)[1].strip()
                else:
                    query_line = line
            elif line.startswith('params:'):
                params_line = line

        if not query_line:
            raise ValueError("Could not find SQL query in debug text")

        # Parse parameters
        params = []
        if params_line:
            # Extract the list part after 'params:'
            params_text = params_line.split('params:', 1)[1].strip()
            if params_text.startswith('[') and params_text.endswith(']'):
                # Parse as JSON-like array
                try:
                    params = json.loads(params_text)
                except json.JSONDecodeError:
                    # Fallback: manual parsing
                    params_text = params_text[1:-1]  # Remove brackets
                    params = [self._parse_param(p.strip()) for p in params_text.split(',')]

        return query_line, params

    def _parse_param(self, param_str: str) -> Union[int, float, str, None]:
        """Parse a single parameter string into appropriate Python type."""
        param_str = param_str.strip()

        if param_str.lower() == 'null':
            return None

        # Try integer
        try:
            return int(param_str)
        except ValueError:
            pass

        # Try float
        try:
            return float(param_str)
        except ValueError:
            pass

        # Remove quotes if present
        if (param_str.startswith('"') and param_str.endswith('"')) or \
           (param_str.startswith("'") and param_str.endswith("'")):
            return param_str[1:-1]

        return param_str

    def substitute_parameters(self, query: str, params: List[Any]) -> str:
        """
        Replace parameter placeholders (?) with actual values.

        Args:
            query: SQL query with ? placeholders
            params: List of parameter values

        Returns:
            SQL query with substituted parameters
        """
        if not params:
            return query

        param_index = 0
        result = []
        i = 0

        while i < len(query):
            if query[i] == '?' and param_index < len(params):
                # Replace ? with the parameter value
                param_value = params[param_index]

                if param_value is None:
                    result.append('NULL')
                elif isinstance(param_value, str):
                    # Escape single quotes in strings
                    escaped = param_value.replace("'", "''")
                    result.append(f"'{escaped}'")
                elif isinstance(param_value, (int, float)):
                    result.append(str(param_value))
                else:
                    result.append(str(param_value))

                param_index += 1
            else:
                result.append(query[i])
            i += 1

        return ''.join(result)

    def format_sql(self, query: str) -> str:
        """
        Format SQL query with proper indentation and line breaks.

        Args:
            query: SQL query string

        Returns:
            Formatted SQL query
        """
        # Remove extra whitespace
        query = ' '.join(query.split())

        # Keywords that should start a new line
        keywords = [
            'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER BY', 'GROUP BY',
            'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'INNER JOIN', 'LEFT JOIN',
            'RIGHT JOIN', 'FULL JOIN', 'UNION', 'INTERSECT', 'EXCEPT'
        ]

        # Add line breaks before keywords
        formatted = query
        for keyword in keywords:
            pattern = r'\b' + re.escape(keyword) + r'\b'
            formatted = re.sub(pattern, f'\n{keyword}', formatted, flags=re.IGNORECASE)

        lines = formatted.split('\n')
        result = []
        indent = 0

        for line in lines:
            line = line.strip()
            if not line:
                continue

            # Adjust indentation for closing parentheses
            if line.startswith(')'):
                indent = max(0, indent - 1)

            # Add indented line
            result.append('    ' * indent + line)

            # Adjust indentation for opening parentheses
            if '(' in line and line.count('(') > line.count(')'):
                indent += line.count('(') - line.count(')')
            elif ')' in line and line.count(')') > line.count('('):
                indent -= line.count(')') - line.count('(')
                indent = max(0, indent)

        return '\n'.join(result)

    def handle_in_clauses(self, query: str) -> str:
        """
        Format IN clauses to be more readable.

        Args:
            query: SQL query string

        Returns:
            Query with formatted IN clauses
        """
        # Pattern to match IN clauses
        in_pattern = r'IN\s*\(([^)]+)\)'

        def format_in_clause(match):
            content = match.group(1)
            values = [v.strip() for v in content.split(',')]

            # If more than 5 values, put each on a new line
            if len(values) > 5:
                formatted_values = ',\n        '.join(values)
                return f'IN (\n        {formatted_values}\n    )'
            else:
                return f'IN ({", ".join(values)})'

        return re.sub(in_pattern, format_in_clause, query, flags=re.IGNORECASE)

    def process_debug_query(self, debug_text: str) -> str:
        """
        Main function to process debug SQL query text.

        Args:
            debug_text: The debug log text

        Returns:
            Formatted SQL query with substituted parameters
        """
        try:
            # Parse the debug text
            query, params = self.parse_debug_query(debug_text)

            # Substitute parameters
            substituted_query = self.substitute_parameters(query, params)

            # Format the query
            formatted_query = self.format_sql(substituted_query)

            # Handle IN clauses
            final_query = self.handle_in_clauses(formatted_query)

            return final_query

        except Exception as e:
            return f"Error processing query: {str(e)}\n\nOriginal text:\n{debug_text}"

def main():
    """Example usage of the SQLQueryFormatter."""

    # Read debug text from stdin
    import sys
    debug_text = sys.stdin.read()

    formatter = SQLQueryFormatter()
    result = formatter.process_debug_query(debug_text)

    print("-- Formatted SQL Query:")
    print("-- =" * 50)
    print(result)

if __name__ == "__main__":
    main()
