using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace RevitOperator.DynamicRevitWorker;

// Only the generated source tree is rewritten. The host-supplied callback is
// installed by a compiler-owned bridge after source admission, never by task code.
// This is cooperative control of managed source, NOT a process sandbox or a way
// to interrupt an already-running Revit/BCL call.
internal sealed class NativeProgramInstrumentation : CSharpSyntaxRewriter
{
    internal const string BoundaryType = "RevitOperator.Generated.NativeExecutionBoundaryV1";
    private readonly SemanticModel _model;
    internal NativeProgramInstrumentation(SemanticModel model) => _model = model;
    private static StatementSyntax Tick() => SyntaxFactory.ParseStatement("global::" + BoundaryType + ".Checkpoint();");
    public override SyntaxNode? VisitBlock(BlockSyntax node)
    {
        var block = (BlockSyntax)base.VisitBlock(node)!;
        return block.WithStatements(block.Statements.Insert(0, Tick()));
    }
    private static StatementSyntax LoopBody(StatementSyntax body) => body is BlockSyntax ? body : SyntaxFactory.Block(Tick(), body);
    public override SyntaxNode? VisitWhileStatement(WhileStatementSyntax node)
    { var n = (WhileStatementSyntax)base.VisitWhileStatement(node)!; return n.WithStatement(LoopBody(n.Statement)); }
    public override SyntaxNode? VisitDoStatement(DoStatementSyntax node)
    { var n = (DoStatementSyntax)base.VisitDoStatement(node)!; return n.WithStatement(LoopBody(n.Statement)); }
    public override SyntaxNode? VisitForStatement(ForStatementSyntax node)
    { var n = (ForStatementSyntax)base.VisitForStatement(node)!; return n.WithStatement(LoopBody(n.Statement)); }
    public override SyntaxNode? VisitForEachStatement(ForEachStatementSyntax node)
    { var n = (ForEachStatementSyntax)base.VisitForEachStatement(node)!; return n.WithStatement(LoopBody(n.Statement)); }
    public override SyntaxNode? VisitForEachVariableStatement(ForEachVariableStatementSyntax node)
    { var n = (ForEachVariableStatementSyntax)base.VisitForEachVariableStatement(node)!; return n.WithStatement(LoopBody(n.Statement)); }

    private static BlockSyntax ExpressionBody(ExpressionSyntax expression, bool returnsVoid) => SyntaxFactory.Block(Tick(),
        expression is ThrowExpressionSyntax thrown ? SyntaxFactory.ThrowStatement(thrown.Expression) :
        returnsVoid ? SyntaxFactory.ExpressionStatement(expression) : SyntaxFactory.ReturnStatement(expression));
    public override SyntaxNode? VisitMethodDeclaration(MethodDeclarationSyntax node)
    {
        var n = (MethodDeclarationSyntax)base.VisitMethodDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression,
            _model.GetDeclaredSymbol(node)!.ReturnsVoid)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitLocalFunctionStatement(LocalFunctionStatementSyntax node)
    {
        var n = (LocalFunctionStatementSyntax)base.VisitLocalFunctionStatement(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression,
            _model.GetDeclaredSymbol(node)!.ReturnsVoid)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitConstructorDeclaration(ConstructorDeclarationSyntax node)
    {
        var n = (ConstructorDeclarationSyntax)base.VisitConstructorDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression, true)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitOperatorDeclaration(OperatorDeclarationSyntax node)
    {
        var n = (OperatorDeclarationSyntax)base.VisitOperatorDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression, false)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitConversionOperatorDeclaration(ConversionOperatorDeclarationSyntax node)
    {
        var n = (ConversionOperatorDeclarationSyntax)base.VisitConversionOperatorDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression, false)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitAccessorDeclaration(AccessorDeclarationSyntax node)
    {
        var n = (AccessorDeclarationSyntax)base.VisitAccessorDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithBody(ExpressionBody(n.ExpressionBody.Expression, !n.IsKind(SyntaxKind.GetAccessorDeclaration))).WithExpressionBody(null).WithSemicolonToken(default);
    }
    private static AccessorListSyntax Getter(ExpressionSyntax expression) => SyntaxFactory.AccessorList(
        SyntaxFactory.SingletonList(SyntaxFactory.AccessorDeclaration(SyntaxKind.GetAccessorDeclaration).WithBody(ExpressionBody(expression, false))));
    public override SyntaxNode? VisitPropertyDeclaration(PropertyDeclarationSyntax node)
    {
        var n = (PropertyDeclarationSyntax)base.VisitPropertyDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithAccessorList(Getter(n.ExpressionBody.Expression)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitIndexerDeclaration(IndexerDeclarationSyntax node)
    {
        var n = (IndexerDeclarationSyntax)base.VisitIndexerDeclaration(node)!;
        return n.ExpressionBody == null ? n : n.WithAccessorList(Getter(n.ExpressionBody.Expression)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    private bool LambdaVoid(LambdaExpressionSyntax node) =>
        (_model.GetTypeInfo(node).ConvertedType as INamedTypeSymbol)?.DelegateInvokeMethod?.ReturnsVoid ?? false;
    public override SyntaxNode? VisitSimpleLambdaExpression(SimpleLambdaExpressionSyntax node)
    {
        var n = (SimpleLambdaExpressionSyntax)base.VisitSimpleLambdaExpression(node)!;
        return n.Body is ExpressionSyntax e ? n.WithBody(ExpressionBody(e, LambdaVoid(node))) : n;
    }
    public override SyntaxNode? VisitParenthesizedLambdaExpression(ParenthesizedLambdaExpressionSyntax node)
    {
        var n = (ParenthesizedLambdaExpressionSyntax)base.VisitParenthesizedLambdaExpression(node)!;
        return n.Body is ExpressionSyntax e ? n.WithBody(ExpressionBody(e, LambdaVoid(node))) : n;
    }

    internal static string Bridge(string entryType) => @"
namespace RevitOperator.Generated {
 public static class NativeExecutionBoundaryV1 {
  [System.ThreadStatic] private static System.Action callback;
  public static void Checkpoint() {
   var current = callback;
   if(current == null) throw new System.InvalidOperationException(""Native execution requires the host checkpoint."");
   current();
  }
  public static string Run(Autodesk.Revit.DB.Document document, System.Action checkpoint) {
   if(checkpoint == null) throw new System.ArgumentNullException(""checkpoint"");
   if(callback != null) throw new System.InvalidOperationException(""Nested native program entry is not allowed."");
   callback = checkpoint;
   try {
    Checkpoint();
    var result = global::" + entryType + @".Execute(document);
    Checkpoint();
    if(result == null || result.Length > 32768) throw new System.InvalidOperationException(""Native program result exceeds the bounded text contract."");
    return result;
   } finally { callback = null; }
  }
 }
}";
}
